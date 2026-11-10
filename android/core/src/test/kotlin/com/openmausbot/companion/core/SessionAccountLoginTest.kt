package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest

class SessionAccountLoginTest {
    @Test
    fun connectWithAccountPersistsTheAccountTokenAndDropsTheLoginFlag() = runTest {
        val connections = MemoryConnectionStore()
        val tokens = MemoryTokenStore()
        val onboarding = InMemoryOnboardingStore()
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = onboarding,
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, token -> CompanionClient(connection, token) },
            pairFn = { _, _, _, _ -> error("pairing is not the account path") },
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
            metadataFn = { throw APIError.Status(404) },
        )
        session.awaitRestored()
        session.beginAccountLogin()
        assertTrue(session.accountLoginRequested.value)

        val id = "12345678-1234-4234-8234-123456789abc"
        val endpoint = assertNotNull(
            CompanionEndpoint.create(
                "https://gateway.example/v1/companion/$id",
                CompanionEndpointKind.HOSTED,
                0,
            ),
        )
        val signIn = AccountGateway.SignIn(
            origin = "https://gateway.example",
            token = "omb_acct_test",
            userId = "user-1",
            email = "ada@example.com",
        )
        session.connectWithAccount(
            signIn,
            listOf(AccountGateway.DesktopHost(id, "Ada's Mac", endpoint)),
            caPem = "TEST-CA",
        )

        val bound = assertNotNull(session.connection.value)
        assertEquals("account-$id", bound.id)
        assertEquals("Ada's Mac", bound.name)
        assertEquals("TEST-CA", bound.gatewayCaPem)
        assertEquals(setOf(CompanionEndpointKind.HOSTED), bound.allowedRouteKinds)
        assertEquals("omb_acct_test", tokens.saved[bound.id])
        assertEquals(bound, connections.registry?.activeConnection)
        assertTrue(onboarding.notificationOnboardingPending())
        assertFalse(session.accountLoginRequested.value)
        assertFalse(session.pairingRequested.value)
    }
}

private class MemoryConnectionStore : ConnectionStore {
    var registry: ConnectionRegistry? = null
    override suspend fun load(): Connection? = registry?.activeConnection
    override suspend fun save(connection: Connection) {
        registry = (registry ?: ConnectionRegistry()).upsert(connection)
    }
    override suspend fun clear() { registry = ConnectionRegistry() }
    override suspend fun loadRegistry() = ConnectionRegistryRestore(registry ?: ConnectionRegistry(), false)
    override suspend fun saveRegistry(registry: ConnectionRegistry) { this.registry = registry }
    override suspend fun clearRegistry() { registry = ConnectionRegistry() }
}

private class MemoryTokenStore : TokenStore {
    val saved = linkedMapOf<String, String>()
    override suspend fun save(connectionId: String, token: String) { saved[connectionId] = token }
    override suspend fun read(connectionId: String) =
        saved[connectionId]?.let { TokenStore.ReadResult.Found(it) } ?: TokenStore.ReadResult.Missing
    override suspend fun remove(connectionId: String) { saved.remove(connectionId) }
}

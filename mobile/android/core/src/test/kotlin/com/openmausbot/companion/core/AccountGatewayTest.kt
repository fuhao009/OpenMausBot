package com.openmausbot.companion.core

import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Before

class AccountGatewayTest {
    private val rootCert = HeldCertificate.Builder()
        .certificateAuthority(0)
        .commonName("test-root")
        .build()
    private val serverCert = HeldCertificate.Builder()
        .signedBy(rootCert)
        .commonName("localhost")
        .addSubjectAlternativeName("localhost")
        .addSubjectAlternativeName("127.0.0.1")
        .build()
    private val serverHandshake = HandshakeCertificates.Builder()
        .heldCertificate(serverCert, rootCert.certificate)
        .build()
    private val server = MockWebServer()

    @Before
    fun startServer() {
        server.useHttps(serverHandshake.sslSocketFactory(), false)
        server.start()
    }

    @After
    fun shutdown() {
        server.shutdown()
    }

    private fun origin(): String = "https://127.0.0.1:${server.port}"

    private fun client() = AccountGateway.httpClient(rootCert.certificatePem())

    @Test
    fun signInThenListsOnlyDesktopInstallations() {
        server.enqueue(
            MockResponse().setBody(
                """{"token":"omb_acct_test","user":{"id":"user-1","email":"ada@example.com"}}""",
            ),
        )
        val phoneId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val desktopId = "12345678-1234-4234-8234-123456789abc"
        server.enqueue(
            MockResponse().setBody(
                """
                {"installations":[
                  {"id":"$desktopId","name":"Ada's Mac","platform":"darwin"},
                  {"id":"$phoneId","name":"Phone","platform":"android"}
                ]}
                """.trimIndent(),
            ),
        )

        val client = client()
        val signIn = AccountGateway.signInWithPassword(origin(), "ada@example.com", "abcdefghij", client)
        assertEquals("omb_acct_test", signIn.token)
        assertEquals("user-1", signIn.userId)
        val hosts = AccountGateway.listDesktopHosts(signIn, client)
        assertEquals(1, hosts.size)
        assertEquals(desktopId, hosts.single().installationId)
        assertEquals("Ada's Mac", hosts.single().name)
        assertEquals("${origin()}/v1/companion/$desktopId", hosts.single().endpoint.url)
        assertEquals(CompanionEndpointKind.HOSTED, hosts.single().endpoint.kind)

        val recordedSignIn = server.takeRequest(1, TimeUnit.SECONDS)
        assertNotNull(recordedSignIn)
        assertEquals("/api/auth/sign-in/email", recordedSignIn.path)
        val recordedList = server.takeRequest(1, TimeUnit.SECONDS)
        assertNotNull(recordedList)
        assertEquals("/v1/installations", recordedList.path)
        assertEquals("Bearer omb_acct_test", recordedList.getHeader("Authorization"))
    }

    @Test
    fun rejectedPasswordDoesNotListInstallations() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
        val error = assertFailsWith<APIError.Unexpected> {
            AccountGateway.signInWithPassword(origin(), "ada@example.com", "abcdefghij", client())
        }
        assertTrue(error.message.orEmpty().contains("email or password", ignoreCase = true))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun connectionUsesTheGatewayPathAndDoesNotGrantAPairingCode() {
        val id = "12345678-1234-4234-8234-123456789abc"
        val endpoint = assertNotNull(
            CompanionEndpoint.create(
                "https://gateway.example/v1/companion/$id",
                CompanionEndpointKind.HOSTED,
                0,
            ),
        )
        val host = AccountGateway.DesktopHost(id, "Studio", endpoint)
        val connection = assertNotNull(AccountGateway.connectionFor("https://gateway.example", host, "CA"))
        assertEquals("account-$id", connection.id)
        assertEquals(setOf(CompanionEndpointKind.HOSTED), connection.allowedRouteKinds)
        assertEquals("CA", connection.gatewayCaPem)
        assertEquals("/v1/companion/$id", java.net.URI(connection.activeEndpoint!!.url).rawPath)
    }
}

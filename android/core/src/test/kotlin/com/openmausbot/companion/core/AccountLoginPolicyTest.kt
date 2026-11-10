package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AccountLoginPolicyTest {
    @Test
    fun acceptsAnHttpsGatewayAndEmail() {
        val result = AccountLoginPolicy.validate(
            origin = "gateway.example:8787",
            email = "ada@example.com",
            password = "abcdefghij",
        )
        assertTrue(result.ok)
        assertEquals("https://gateway.example:8787", AccountGateway.normalizeOrigin("gateway.example:8787"))
        assertEquals("https://gateway.example:8787", AccountGateway.normalizeOrigin("https://gateway.example:8787/"))
    }

    @Test
    fun rejectsHttpAndEmptyEmailAndShortPassword() {
        val result = AccountLoginPolicy.validate(
            origin = "http://gateway.example",
            email = "not-an-email",
            password = "short",
        )
        assertFalse(result.ok)
        assertNotNull(result.origin)
        assertNotNull(result.email)
        assertNotNull(result.password)
        assertNull(AccountGateway.normalizeOrigin("http://127.0.0.1:8787"))
        assertNull(AccountGateway.normalizeOrigin("https://gateway.example/v1"))
    }

    @Test
    fun companionUrlJoinsTheInstallationPath() {
        val id = "12345678-1234-4234-8234-123456789abc"
        assertEquals(
            "https://gateway.example/v1/companion/$id",
            AccountGateway.companionUrl("https://gateway.example", id),
        )
    }
}

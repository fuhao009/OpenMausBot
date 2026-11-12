package com.openmausbot.companion.core

import java.io.ByteArrayInputStream
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Sign in to the same Hezuo account gateway the desktop uses, then build a
 * hosted connection to each of that account's desktop installations. No
 * pairing code is exchanged.
 */
object AccountGateway {
    private val json = Json { ignoreUnknownKeys = true; isLenient = false }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val desktopPlatforms = setOf("darwin", "windows", "linux")
    val passwordMin = 10
    val passwordMax = 128

    data class SignIn(
        val origin: String,
        val token: String,
        val userId: String,
        val email: String,
    )

    data class DesktopHost(
        val installationId: String,
        val name: String,
        val endpoint: CompanionEndpoint,
    )

    fun normalizeOrigin(raw: String): String? {
        val trimmed = raw.trim().trimEnd('/')
        val prefixed = when {
            trimmed.startsWith("https://", ignoreCase = true) -> trimmed
            trimmed.startsWith("http://", ignoreCase = true) -> return null
            trimmed.isEmpty() -> return null
            else -> "https://$trimmed"
        }
        val parsed = runCatching { java.net.URI(prefixed) }.getOrNull() ?: return null
        if (!parsed.scheme.equals("https", ignoreCase = true)) return null
        if (parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) return null
        if (!parsed.rawPath.isNullOrEmpty() && parsed.rawPath != "/") return null
        val host = parsed.host?.lowercase() ?: return null
        val port = parsed.port
        return runCatching {
            java.net.URI("https", null, host, port, "/", null, null).toASCIIString().trimEnd('/')
        }.getOrNull()
    }

    fun companionUrl(origin: String, installationId: String): String =
        "${origin.trimEnd('/')}/v1/companion/${installationId.lowercase()}"

    fun connectionFor(origin: String, host: DesktopHost, caPem: String? = null): Connection? {
        val endpoint = host.endpoint
        return Connection(
            id = "account-${host.installationId}",
            name = host.name.ifBlank { endpoint.host },
            host = endpoint.host,
            port = endpoint.port,
            activeEndpoint = endpoint,
            endpoints = listOf(endpoint),
            allowedRouteKinds = setOf(CompanionEndpointKind.HOSTED),
            gatewayCaPem = caPem?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    fun httpClient(caPem: String? = null, base: OkHttpClient = OkHttpClient()): OkHttpClient {
        val builder = base.newBuilder()
            .callTimeout(20, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
        val pem = caPem?.trim().orEmpty()
        if (pem.isNotEmpty()) {
            val factory = CertificateFactory.getInstance("X.509")
            val cert = factory.generateCertificate(ByteArrayInputStream(pem.toByteArray()))
            val keyStore = KeyStore.getInstance(KeyStore.getDefaultType())
            keyStore.load(null)
            keyStore.setCertificateEntry("gateway", cert)
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(keyStore)
            val context = SSLContext.getInstance("TLS")
            context.init(null, tmf.trustManagers, null)
            val trust = tmf.trustManagers.filterIsInstance<X509TrustManager>().single()
            builder.sslSocketFactory(context.socketFactory, trust)
        }
        return builder.build()
    }

    fun signInWithPassword(
        origin: String,
        email: String,
        password: String,
        client: OkHttpClient,
    ): SignIn {
        val normalized = normalizeOrigin(origin) ?: throw APIError.BadUrl
        if (password.length !in passwordMin..passwordMax) {
            throw APIError.Unexpected("Enter a password of $passwordMin–$passwordMax characters.")
        }
        val body = json.encodeToString(
            PasswordRequest.serializer(),
            PasswordRequest(email = email.trim(), password = password),
        )
        val request = Request.Builder()
            .url("$normalized/api/auth/sign-in/email")
            .post(body.toRequestBody(jsonMedia))
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 401 || response.code == 403) {
                throw APIError.Unexpected("That email or password was not accepted.")
            }
            if (!response.isSuccessful) {
                throw APIError.Unexpected("Could not reach the Hezuo account gateway.")
            }
            val payload = runCatching { json.decodeFromString(SessionResponse.serializer(), text) }.getOrNull()
                ?: throw APIError.Unexpected("The account gateway sent an unexpected reply.")
            val token = payload.token?.takeIf { it.isNotBlank() }
                ?: throw APIError.Unexpected("The account gateway sent an unexpected reply.")
            return SignIn(
                origin = normalized,
                token = token,
                userId = payload.user?.id.orEmpty(),
                email = payload.user?.email ?: email.trim(),
            )
        }
    }

    fun listDesktopHosts(signIn: SignIn, client: OkHttpClient): List<DesktopHost> {
        val request = Request.Builder()
            .url("${signIn.origin}/v1/installations")
            .header("Authorization", "Bearer ${signIn.token}")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 401 || response.code == 403) {
                throw APIError.Status(401)
            }
            if (!response.isSuccessful) {
                throw APIError.Unexpected("Could not list this account's computers.")
            }
            val payload = runCatching { json.decodeFromString(InstallationsResponse.serializer(), text) }.getOrNull()
                ?: throw APIError.Unexpected("The account gateway sent an unexpected reply.")
            return payload.installations.mapNotNull { item ->
                if (item.platform !in desktopPlatforms) return@mapNotNull null
                val url = companionUrl(signIn.origin, item.id)
                val endpoint = CompanionEndpoint.create(url, CompanionEndpointKind.HOSTED, 0)
                    ?: return@mapNotNull null
                DesktopHost(item.id, item.name ?: item.displayName ?: endpoint.host, endpoint)
            }
        }
    }

    @Serializable
    private data class PasswordRequest(val email: String, val password: String)

    @Serializable
    private data class SessionResponse(
        val token: String? = null,
        val user: SessionUser? = null,
    )

    @Serializable
    private data class SessionUser(val id: String? = null, val email: String? = null)

    @Serializable
    private data class InstallationsResponse(val installations: List<Installation> = emptyList())

    @Serializable
    private data class Installation(
        val id: String,
        val name: String? = null,
        @SerialName("display_name") val displayName: String? = null,
        val platform: String? = null,
    )
}

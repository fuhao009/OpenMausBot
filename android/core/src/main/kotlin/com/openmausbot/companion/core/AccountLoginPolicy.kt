package com.openmausbot.companion.core

/** Pure checks for the account-login form, so the screen cannot invent its own rules. */
object AccountLoginPolicy {
    const val TITLE = "Sign in to Hezuo"
    const val SUBTITLE =
        "Use the same account as your computer. No pairing code needed."
    const val ORIGIN_LABEL = "Account gateway"
    const val EMAIL_LABEL = "Email"
    const val PASSWORD_LABEL = "Password"
    const val CA_LABEL = "Gateway certificate (optional)"
    const val SUBMIT = "Sign in"
    const val NO_DESKTOPS =
        "No desktop Hezuo is signed into this account yet. Sign in on your computer first."

    data class Validation(
        val origin: String? = null,
        val email: String? = null,
        val password: String? = null,
    ) {
        val ok: Boolean get() = origin == null && email == null && password == null
    }

    fun looksLikeEmail(raw: String): Boolean {
        val value = raw.trim()
        val at = value.indexOf('@')
        return at in 1 until value.lastIndex && '.' in value.substring(at + 1)
    }

    fun validate(origin: String, email: String, password: String): Validation {
        val originError = when (AccountGateway.normalizeOrigin(origin)) {
            null -> "Enter the HTTPS address of your Hezuo account gateway."
            else -> null
        }
        val emailError = when {
            email.trim().isEmpty() -> "Enter the email you use on your computer."
            !looksLikeEmail(email) -> "Enter a valid email address."
            else -> null
        }
        val passwordError = when {
            password.length < AccountGateway.passwordMin ->
                "Enter a password of ${AccountGateway.passwordMin}–${AccountGateway.passwordMax} characters."
            password.length > AccountGateway.passwordMax ->
                "Enter a password of ${AccountGateway.passwordMin}–${AccountGateway.passwordMax} characters."
            else -> null
        }
        return Validation(originError, emailError, passwordError)
    }
}

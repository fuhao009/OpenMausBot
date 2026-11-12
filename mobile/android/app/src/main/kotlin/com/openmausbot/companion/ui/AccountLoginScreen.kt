package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.AccountGateway
import com.openmausbot.companion.core.AccountLoginPolicy
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun AccountLoginScreen(session: Session, onCancel: () -> Unit) {
    var origin by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var caPem by remember { mutableStateOf("") }
    var originError by remember { mutableStateOf<String?>(null) }
    var emailError by remember { mutableStateOf<String?>(null) }
    var passwordError by remember { mutableStateOf<String?>(null) }
    var formError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Top,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            AccountLoginPolicy.TITLE,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            AccountLoginPolicy.SUBTITLE,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = origin,
            onValueChange = { origin = it; originError = null; formError = null },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(AccountLoginPolicy.ORIGIN_LABEL) },
            placeholder = { Text("https://gateway.example") },
            singleLine = true,
            enabled = !busy,
            isError = originError != null,
            supportingText = originError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = email,
            onValueChange = { email = it; emailError = null; formError = null },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(AccountLoginPolicy.EMAIL_LABEL) },
            singleLine = true,
            enabled = !busy,
            isError = emailError != null,
            supportingText = emailError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it; passwordError = null; formError = null },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(AccountLoginPolicy.PASSWORD_LABEL) },
            singleLine = true,
            enabled = !busy,
            isError = passwordError != null,
            supportingText = passwordError?.let { { Text(it) } },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = caPem,
            onValueChange = { caPem = it; formError = null },
            modifier = Modifier.fillMaxWidth().height(120.dp),
            label = { Text(AccountLoginPolicy.CA_LABEL) },
            enabled = !busy,
        )
        formError?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = {
                val validation = AccountLoginPolicy.validate(origin, email, password)
                originError = validation.origin
                emailError = validation.email
                passwordError = validation.password
                if (!validation.ok) return@Button
                busy = true
                formError = null
                scope.launch {
                    try {
                        val ca = caPem.trim().takeIf { it.isNotEmpty() }
                        val http = AccountGateway.httpClient(ca)
                        val signIn = withContext(Dispatchers.IO) {
                            AccountGateway.signInWithPassword(origin, email, password, http)
                        }
                        val hosts = withContext(Dispatchers.IO) {
                            AccountGateway.listDesktopHosts(signIn, http)
                        }
                        if (hosts.isEmpty()) {
                            formError = AccountLoginPolicy.NO_DESKTOPS
                        } else {
                            session.connectWithAccount(signIn, hosts, ca)
                        }
                    } catch (error: Throwable) {
                        formError = error.message ?: "Could not sign in to the account gateway."
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
            } else {
                Text(AccountLoginPolicy.SUBMIT)
            }
        }
        TextButton(onClick = onCancel, enabled = !busy) {
            Text("Cancel")
        }
    }
}

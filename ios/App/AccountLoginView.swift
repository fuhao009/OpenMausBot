import SwiftUI
import CompanionCore

struct AccountLoginView: View {
    @EnvironmentObject private var session: Session
    var onCancel: () -> Void

    @State private var origin = ""
    @State private var email = ""
    @State private var password = ""
    @State private var caPem = ""
    @State private var originError: String?
    @State private var emailError: String?
    @State private var passwordError: String?
    @State private var formError: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(AccountGateway.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("https://gateway.example", text: $origin)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    if let originError {
                        Text(originError).foregroundStyle(.red)
                    }
                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    if let emailError {
                        Text(emailError).foregroundStyle(.red)
                    }
                    SecureField("Password", text: $password)
                    if let passwordError {
                        Text(passwordError).foregroundStyle(.red)
                    }
                }
                Section {
                    TextField("Gateway certificate (optional)", text: $caPem, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(3...8)
                }
                if let formError {
                    Section {
                        Text(formError).foregroundStyle(.red)
                    }
                }
                Section {
                    Button(AccountGateway.title) { submit() }
                        .disabled(busy)
                    if busy { ProgressView() }
                }
            }
            .navigationTitle(AccountGateway.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(busy)
                }
            }
        }
    }

    private func submit() {
        let check = AccountGateway.validate(origin: origin, email: email, password: password)
        originError = check.origin
        emailError = check.email
        passwordError = check.password
        guard check.origin == nil, check.email == nil, check.password == nil else { return }
        busy = true
        formError = nil
        let ca = caPem.trimmingCharacters(in: .whitespacesAndNewlines)
        let caValue = ca.isEmpty ? nil : ca
        let urlSession = AccountGateway.urlSession(trusting: caValue)
        Task {
            do {
                let signIn = try await AccountGateway.signInWithPassword(
                    origin: origin,
                    email: email,
                    password: password,
                    session: urlSession
                )
                let hosts = try await AccountGateway.listDesktopHosts(signIn: signIn, session: urlSession)
                if hosts.isEmpty {
                    await MainActor.run {
                        formError = AccountGateway.noDesktops
                        busy = false
                    }
                    return
                }
                try await MainActor.run {
                    try session.connectWithAccount(signIn: signIn, hosts: hosts, caPem: caValue)
                    busy = false
                }
            } catch {
                await MainActor.run {
                    formError = error.localizedDescription
                    busy = false
                }
            }
        }
    }
}

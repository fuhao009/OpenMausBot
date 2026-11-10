import Foundation

#if canImport(Security)
import Security
#endif

/// Sign in to the same Hezuo account gateway the desktop uses, then build a
/// hosted connection to each of that account's desktop installations. No
/// pairing code is exchanged.
public enum AccountGateway {
    public static let passwordMin = 10
    public static let passwordMax = 128

    public struct SignIn: Sendable, Equatable {
        public var origin: String
        public var token: String
        public var userId: String
        public var email: String

        public init(origin: String, token: String, userId: String, email: String) {
            self.origin = origin
            self.token = token
            self.userId = userId
            self.email = email
        }
    }

    public struct DesktopHost: Sendable, Equatable {
        public var installationId: String
        public var name: String
        public var endpoint: CompanionEndpoint

        public init(installationId: String, name: String, endpoint: CompanionEndpoint) {
            self.installationId = installationId
            self.name = name
            self.endpoint = endpoint
        }
    }

    public static let title = "Sign in to Hezuo"
    public static let subtitle = "Use the same account as your computer. No pairing code needed."
    public static let noDesktops =
        "No desktop Hezuo is signed into this account yet. Sign in on your computer first."

    public static func normalizeOrigin(_ raw: String) -> String? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let prefixed: String
        if trimmed.lowercased().hasPrefix("https://") {
            prefixed = trimmed
        } else if trimmed.lowercased().hasPrefix("http://") {
            return nil
        } else if trimmed.isEmpty {
            return nil
        } else {
            prefixed = "https://" + trimmed
        }
        guard var components = URLComponents(string: prefixed),
              components.scheme?.lowercased() == "https",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let host = components.host, !host.isEmpty
        else { return nil }
        let path = components.path
        guard path.isEmpty || path == "/" else { return nil }
        components.scheme = "https"
        components.host = host.lowercased()
        components.path = ""
        guard var value = components.url?.absoluteString else { return nil }
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    public static func companionURL(origin: String, installationId: String) -> String {
        var root = origin
        while root.hasSuffix("/") { root.removeLast() }
        return root + "/v1/companion/" + installationId.lowercased()
    }

    public static func connection(origin: String, host: DesktopHost, caPem: String? = nil) -> Connection? {
        let pem = caPem?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Connection(
            id: "account-" + host.installationId,
            name: host.name.isEmpty ? host.endpoint.host : host.name,
            host: host.endpoint.host,
            port: host.endpoint.port,
            activeEndpoint: host.endpoint,
            endpoints: [host.endpoint],
            allowedRouteKinds: [.hosted],
            gatewayCaPem: (pem?.isEmpty == false) ? pem : nil
        )
    }

    public static func looksLikeEmail(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = value.firstIndex(of: "@"), at > value.startIndex, at < value.index(before: value.endIndex) else {
            return false
        }
        return value[value.index(after: at)...].contains(".")
    }

    public static func validate(origin: String, email: String, password: String) -> (origin: String?, email: String?, password: String?) {
        let originError: String? = normalizeOrigin(origin) == nil
            ? "Enter the HTTPS address of your Hezuo account gateway."
            : nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let emailError: String?
        if trimmedEmail.isEmpty {
            emailError = "Enter the email you use on your computer."
        } else if !looksLikeEmail(email) {
            emailError = "Enter a valid email address."
        } else {
            emailError = nil
        }
        let passwordError: String? = (passwordMin...passwordMax).contains(password.count)
            ? nil
            : "Enter a password of \(passwordMin)–\(passwordMax) characters."
        return (originError, emailError, passwordError)
    }

    public static func urlSession(trusting caPem: String?) -> URLSession {
        guard let caPem,
              !caPem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let delegate = TrustDelegate(pem: caPem)
        else { return .shared }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    public static func signInWithPassword(
        origin: String,
        email: String,
        password: String,
        session: URLSession
    ) async throws -> SignIn {
        guard let normalized = normalizeOrigin(origin) else { throw APIError.badURL }
        guard (passwordMin...passwordMax).contains(password.count) else {
            throw APIError.transport("Enter a password of \(passwordMin)–\(passwordMax) characters.")
        }
        guard let url = URL(string: normalized + "/api/auth/sign-in/email") else { throw APIError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
            "password": password,
        ])
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 {
            throw APIError.transport("That email or password was not accepted.")
        }
        guard (200...299).contains(code) else {
            throw APIError.transport("Could not reach the Hezuo account gateway.")
        }
        let payload = try JSONDecoder().decode(SessionResponse.self, from: data)
        guard let token = payload.token, !token.isEmpty else {
            throw APIError.transport("The account gateway sent an unexpected reply.")
        }
        return SignIn(
            origin: normalized,
            token: token,
            userId: payload.user?.id ?? "",
            email: payload.user?.email ?? email.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    public static func listDesktopHosts(signIn: SignIn, session: URLSession) async throws -> [DesktopHost] {
        guard let url = URL(string: signIn.origin + "/v1/installations") else { throw APIError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer " + signIn.token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.status(code: code, message: nil) }
        guard (200...299).contains(code) else {
            throw APIError.transport("Could not list this account's computers.")
        }
        let payload = try JSONDecoder().decode(InstallationsResponse.self, from: data)
        let desktop: Set<String> = ["darwin", "windows", "linux"]
        return payload.installations.compactMap { item in
            guard let platform = item.platform, desktop.contains(platform) else { return nil }
            let url = companionURL(origin: signIn.origin, installationId: item.id)
            guard let endpoint = CompanionEndpoint(url: url, kind: .hosted, priority: 0) else { return nil }
            let name = item.name ?? item.displayName ?? endpoint.host
            return DesktopHost(installationId: item.id, name: name, endpoint: endpoint)
        }
    }

    private struct SessionResponse: Decodable {
        var token: String?
        var user: SessionUser?
    }

    private struct SessionUser: Decodable {
        var id: String?
        var email: String?
    }

    private struct InstallationsResponse: Decodable {
        var installations: [Installation] = []
    }

    private struct Installation: Decodable {
        var id: String
        var name: String?
        var displayName: String?
        var platform: String?

        enum CodingKeys: String, CodingKey {
            case id, name, platform
            case displayName = "display_name"
        }
    }

    final class TrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
        private let certificates: [SecCertificate]

        init?(pem: String) {
            var parsed: [SecCertificate] = []
            let blocks = pem.components(separatedBy: "-----BEGIN CERTIFICATE-----")
            for block in blocks.dropFirst() {
                let body = block.components(separatedBy: "-----END CERTIFICATE-----").first ?? ""
                let base64 = body.components(separatedBy: .whitespacesAndNewlines).joined()
                guard let data = Data(base64Encoded: base64),
                      let cert = SecCertificateCreateWithData(nil, data as CFData)
                else { continue }
                parsed.append(cert)
            }
            guard !parsed.isEmpty else { return nil }
            self.certificates = parsed
        }

        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust
            else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            SecTrustSetAnchorCertificates(trust, certificates as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            var error: CFError?
            if SecTrustEvaluateWithError(trust, &error) {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }
}

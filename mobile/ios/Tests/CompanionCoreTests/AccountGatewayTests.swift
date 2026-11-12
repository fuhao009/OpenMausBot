import Foundation
import XCTest
@testable import CompanionCore

final class AccountGatewayTests: XCTestCase {
    func testNormalizeOriginAcceptsHttpsAndRejectsHttpOrPath() {
        XCTAssertEqual(AccountGateway.normalizeOrigin("gateway.example:8787"), "https://gateway.example:8787")
        XCTAssertEqual(AccountGateway.normalizeOrigin("https://gateway.example:8787/"), "https://gateway.example:8787")
        XCTAssertNil(AccountGateway.normalizeOrigin("http://127.0.0.1:8787"))
        XCTAssertNil(AccountGateway.normalizeOrigin("https://gateway.example/v1"))
    }

    func testValidatePasswordAndEmail() {
        let ok = AccountGateway.validate(
            origin: "https://gateway.example",
            email: "ada@example.com",
            password: "abcdefghij"
        )
        XCTAssertNil(ok.origin)
        XCTAssertNil(ok.email)
        XCTAssertNil(ok.password)

        let bad = AccountGateway.validate(origin: "http://gateway.example", email: "nope", password: "short")
        XCTAssertNotNil(bad.origin)
        XCTAssertNotNil(bad.email)
        XCTAssertNotNil(bad.password)
    }

    func testCompanionURLAndConnectionKeepTheGatewayPath() throws {
        let id = "12345678-1234-4234-8234-123456789abc"
        let url = AccountGateway.companionURL(origin: "https://gateway.example", installationId: id)
        XCTAssertEqual(url, "https://gateway.example/v1/companion/\(id)")
        let endpoint = try XCTUnwrap(CompanionEndpoint(url: url, kind: .hosted, priority: 0))
        XCTAssertEqual(endpoint.url, url)
        XCTAssertNil(CompanionEndpoint(url: "https://gateway.example/v1/companion/not-a-uuid", kind: .hosted, priority: 0))
        XCTAssertNil(CompanionEndpoint(url: "https://public.example/path", kind: .hosted, priority: 0))
        let host = AccountGateway.DesktopHost(installationId: id, name: "Ada's Mac", endpoint: endpoint)
        let connection = try XCTUnwrap(AccountGateway.connection(origin: "https://gateway.example", host: host, caPem: "CA"))
        XCTAssertEqual(connection.id, "account-\(id)")
        XCTAssertEqual(connection.allowedRouteKinds, [.hosted])
        XCTAssertEqual(connection.gatewayCaPem, "CA")
    }
}

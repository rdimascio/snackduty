import Foundation
import Security

public protocol SessionCookieStoring: Sendable {
    func sessionCookie(for origin: URL) throws -> String?
    func saveSessionCookie(_ cookie: String, for origin: URL) throws
    func clearSession(for origin: URL) throws
}

public enum SessionCookieStoreError: Error, Equatable, Sendable {
    case invalidOrigin
    case unavailable
}

/// Serializes cookie mutation and rejects responses that began before a newer
/// authentication boundary such as logout. This prevents a late Set-Cookie from
/// restoring a session that the user already revoked.
actor SessionCookieCoordinator {
    private let store: any SessionCookieStoring
    private var epoch: UInt64 = 0

    init(store: any SessionCookieStoring) {
        self.store = store
    }

    func credential(for origin: URL) throws -> (header: String?, epoch: UInt64) {
        (try store.sessionCookie(for: origin), epoch)
    }

    func persist(_ header: String, for origin: URL, requestEpoch: UInt64) throws {
        guard requestEpoch == epoch else { return }
        try store.saveSessionCookie(header, for: origin)
    }

    func clear(for origin: URL, requestEpoch: UInt64) throws {
        guard requestEpoch == epoch else { return }
        epoch &+= 1
        try store.clearSession(for: origin)
    }

    func invalidatePendingResponses() {
        epoch &+= 1
    }

    func clearUnconditionally(for origin: URL) throws {
        epoch &+= 1
        try store.clearSession(for: origin)
    }
}

/// Stores one opaque Cookie header per API origin. The origin-derived Keychain
/// account prevents a development credential from reaching staging or production.
public struct KeychainSessionCookieStore: SessionCookieStoring, Sendable {
    private let service: String

    public init(service: String = "com.snackday.app.session-cookie") {
        self.service = service
    }

    public func sessionCookie(for origin: URL) throws -> String? {
        let account = try originKey(origin)
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            baseQuery(account: account).merging([
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]) { _, new in new } as CFDictionary,
            &item
        )
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data,
              let cookie = String(data: data, encoding: .utf8), !cookie.isEmpty
        else {
            throw SessionCookieStoreError.unavailable
        }
        return cookie
    }

    public func saveSessionCookie(_ cookie: String, for origin: URL) throws {
        guard !cookie.isEmpty, let data = cookie.data(using: .utf8) else {
            throw SessionCookieStoreError.unavailable
        }
        let account = try originKey(origin)
        let query = baseQuery(account: account)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw SessionCookieStoreError.unavailable
        }

        let insert = query.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { _, new in new }
        guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
            throw SessionCookieStoreError.unavailable
        }
    }

    public func clearSession(for origin: URL) throws {
        let status = SecItemDelete(baseQuery(account: try originKey(origin)) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SessionCookieStoreError.unavailable
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func originKey(_ url: URL) throws -> String {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
              scheme == "https" || scheme == "http"
        else {
            throw SessionCookieStoreError.invalidOrigin
        }
        let defaultPort = scheme == "https" ? 443 : 80
        return "\(scheme)://\(host):\(url.port ?? defaultPort)"
    }
}

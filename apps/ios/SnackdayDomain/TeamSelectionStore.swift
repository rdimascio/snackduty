import Foundation

public protocol TeamSelectionStoring: Sendable {
    func selection(for personID: String) async -> TeamSeasonSelection?
    func saveSelection(_ selection: TeamSeasonSelection, for personID: String) async
    func clearSelection(for personID: String) async
}

/// A small non-sensitive preference store. Selection is keyed by the signed-in
/// adult so one adult never inherits another adult's active team.
public actor UserDefaultsTeamSelectionStore: TeamSelectionStoring {
    private let defaults: UserDefaults
    private let keyPrefix: String

    public init(
        suiteName: String? = nil,
        keyPrefix: String = "snackday.team-season-selection."
    ) {
        if let suiteName, let scopedDefaults = UserDefaults(suiteName: suiteName) {
            self.defaults = scopedDefaults
        } else {
            self.defaults = .standard
        }
        self.keyPrefix = keyPrefix
    }

    public func selection(for personID: String) -> TeamSeasonSelection? {
        let key = storageKey(personID)
        guard let data = defaults.data(forKey: key) else { return nil }
        do {
            return try JSONDecoder().decode(TeamSeasonSelection.self, from: data)
        } catch {
            defaults.removeObject(forKey: key)
            return nil
        }
    }

    public func saveSelection(_ selection: TeamSeasonSelection, for personID: String) {
        guard let data = try? JSONEncoder().encode(selection) else { return }
        defaults.set(data, forKey: storageKey(personID))
    }

    public func clearSelection(for personID: String) {
        defaults.removeObject(forKey: storageKey(personID))
    }

    private func storageKey(_ personID: String) -> String {
        keyPrefix + Data(personID.utf8).base64EncodedString()
    }
}

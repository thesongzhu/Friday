import Foundation

public struct CompanionHotkey: Equatable, Sendable {
  public enum Key: String, Sendable {
    case space
    case escape
  }

  public let command: Bool
  public let shift: Bool
  public let option: Bool
  public let control: Bool
  public let key: Key

  public init(command: Bool, shift: Bool, option: Bool, control: Bool, key: Key) {
    self.command = command
    self.shift = shift
    self.option = option
    self.control = control
    self.key = key
  }

  public init(rawValue: String) throws {
    let tokens = rawValue
      .split(separator: "+")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      .filter { !$0.isEmpty }
    guard let last = tokens.last, let key = Key(rawValue: last) else {
      throw CompanionHotkeyError.invalidKey(rawValue)
    }
    self.command = tokens.contains("cmd") || tokens.contains("command")
    self.shift = tokens.contains("shift")
    self.option = tokens.contains("opt") || tokens.contains("option") || tokens.contains("alt")
    self.control = tokens.contains("ctrl") || tokens.contains("control")
    self.key = key
  }

  public var displayString: String {
    var parts: [String] = []
    if command { parts.append("cmd") }
    if shift { parts.append("shift") }
    if option { parts.append("option") }
    if control { parts.append("control") }
    parts.append(key.rawValue)
    return parts.joined(separator: "+")
  }
}

public enum CompanionHotkeyError: Error, CustomStringConvertible {
  case invalidKey(String)

  public var description: String {
    switch self {
    case .invalidKey(let rawValue):
      return "Unsupported hotkey: \(rawValue)"
    }
  }
}

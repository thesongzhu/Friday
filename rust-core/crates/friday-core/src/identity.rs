//! Device identity and trust role.

/// What kind of device this identity belongs to.
///
/// The role drives the storage profile (gate 21 §2): the Hub holds the source
/// of truth (incl. secret-bearing tables), a phone holds only a cache subset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeviceRole {
    Hub,
    Ios,
    Android,
}

impl DeviceRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceRole::Hub => "hub",
            DeviceRole::Ios => "ios",
            DeviceRole::Android => "android",
        }
    }

    pub fn parse(s: &str) -> Option<DeviceRole> {
        match s {
            "hub" => Some(DeviceRole::Hub),
            "ios" => Some(DeviceRole::Ios),
            "android" => Some(DeviceRole::Android),
            _ => None,
        }
    }

    /// iOS and Android are "phone" roles; the Hub is not.
    pub fn is_phone(&self) -> bool {
        matches!(self, DeviceRole::Ios | DeviceRole::Android)
    }
}

/// One local device's identity (matches `device_identity` table, gate 21 §2.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub role: DeviceRole,
    pub public_key: Vec<u8>,
    pub created_at: i64,
    pub display_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_string_round_trips() {
        for r in [DeviceRole::Hub, DeviceRole::Ios, DeviceRole::Android] {
            assert_eq!(DeviceRole::parse(r.as_str()), Some(r));
        }
        assert_eq!(DeviceRole::parse("watch"), None);
    }

    #[test]
    fn only_phones_are_phones() {
        assert!(!DeviceRole::Hub.is_phone());
        assert!(DeviceRole::Ios.is_phone());
        assert!(DeviceRole::Android.is_phone());
    }
}

//! friday-deepseek — DeepSeek Friday-provider route (Hub-only, secret-bearing).
//!
//! **Unit-2 status: dependency-boundary stub.** This crate exists now so the
//! workspace establishes the trust boundary: it is the provider-secret-bearing
//! crate (it will read `FRIDAY_DEEPSEEK_API_KEY` on the Hub) and must therefore
//! NEVER enter the phone (`friday-ffi`) dependency graph (gate 21 §1/§3). That
//! exclusion is asserted by `friday-arch-tests`.
//!
//! The actual route — runtime `/models` discovery, the chat call, and
//! usage→ledger mapping with `fallback=false` — lands in **Unit 3**. No network
//! access and no secret reads happen in this crate yet.

use friday_core::ProviderKind;

/// Describes the route this crate will own in Unit 3. Carries no secret.
pub struct DeepSeekRoute;

impl DeepSeekRoute {
    pub const PROVIDER: ProviderKind = ProviderKind::DeepSeek;
    pub const BASE_URL_HOST: &'static str = "api.deepseek.com";

    /// The live Friday-provider route is not implemented until Unit 3.
    pub fn is_implemented() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_stub_advertises_route_identity_without_implementing_it() {
        assert_eq!(DeepSeekRoute::BASE_URL_HOST, "api.deepseek.com");
        assert_eq!(DeepSeekRoute::PROVIDER.as_str(), "deepseek");
        assert!(!DeepSeekRoute::is_implemented());
    }
}

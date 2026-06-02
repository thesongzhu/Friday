//! Host binary that drives UniFFI binding generation from the built cdylib:
//!   cargo run -p friday-ffi --bin uniffi-bindgen -- \
//!     generate --library target/debug/libfriday_ffi.dylib --language swift --out-dir <dir>
fn main() {
    uniffi::uniffi_bindgen_main()
}

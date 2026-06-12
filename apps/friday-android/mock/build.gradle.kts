// Friday Android MOCK shell (:mock) — v1 device-proof surface.
//
// A self-contained Jetpack Compose app proving the device-pairing + Hub↔phone
// sync FLOW on the Android emulator. It is a MOCK: no UniFFI, no NDK, no real
// sealed-WS Hub client — all pairing/sync state is a deterministic in-memory
// stub (see PairingViewModel). This keeps `gradle :mock:assembleDebug` building
// from public Maven repos with NO Rust cross-compile, unlike the sibling :app
// (the real-UniFFI Unit-5c bridge proof, which needs build-emu.sh).
//
// AGP 9 has built-in Kotlin; Compose is enabled via the standalone
// `org.jetbrains.kotlin.plugin.compose` plugin + `buildFeatures.compose`.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.friday.mock"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.friday.mock"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1"
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")

    debugImplementation("androidx.compose.ui:ui-tooling")
}

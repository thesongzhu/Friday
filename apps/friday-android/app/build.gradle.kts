plugins {
    // AGP 9 compiles Kotlin via built-in support; no separate Kotlin plugin.
    id("com.android.application")
}

android {
    namespace = "com.friday.shell"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.friday.shell"
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

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Extract the bundled .so files to the on-disk nativeLibraryDir (modern AGP
    // defaults to false, leaving them inside the APK). JNA loads its jnidispatch
    // from a real file via jna.boot.library.path, so it must exist on disk.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
    // The generated UniFFI Kotlin bindings (src/main/kotlin/uniffi/...) and the
    // cross-compiled .so (src/main/jniLibs/<abi>/) are placed by build-emu.sh —
    // both AGP default source locations, both gitignored build artifacts.
}

dependencies {
    // UniFFI's generated Kotlin uses JNA. The @aar ships the Android
    // libjnidispatch.so as a jniLib; JNA 5.16+ loads it on Android via
    // System.loadLibrary (older 5.14 insisted on a classpath resource that AGP
    // refuses to package, throwing "not found in resource path").
    implementation("net.java.dev.jna:jna:5.18.1@aar")
}

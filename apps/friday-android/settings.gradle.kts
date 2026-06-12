pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "friday-android"
include(":app")
// :mock — the self-contained Compose device-proof shell (no UniFFI/NDK).
include(":mock")

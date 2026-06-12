// Root build script. AGP 9.2.1 pairs with the installed Gradle 9.5.1 and
// compileSdk 36. AGP 9 has BUILT-IN Kotlin support, so no separate Kotlin
// plugin is applied (see apps/friday-android/README.md).
plugins {
    id("com.android.application") version "9.2.1" apply false
    // Compose compiler plugin for the :mock module. AGP 9 ships built-in Kotlin;
    // the standalone compose plugin must match that bundled Kotlin version.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0" apply false
}

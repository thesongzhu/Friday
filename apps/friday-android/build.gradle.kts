// Root build script. AGP 9.2.1 pairs with the installed Gradle 9.5.1 and
// compileSdk 36. AGP 9 has BUILT-IN Kotlin support, so no separate Kotlin
// plugin is applied (see apps/friday-android/README.md).
plugins {
    id("com.android.application") version "9.2.1" apply false
}

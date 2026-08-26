// Top-level build file. Plugin versions are declared once here and applied in
// the app module. Versions are pinned so a headless `./gradlew assembleDebug`
// on the Mac mini is reproducible.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24" apply false
    id("com.google.devtools.ksp") version "1.9.24-1.0.20" apply false
}

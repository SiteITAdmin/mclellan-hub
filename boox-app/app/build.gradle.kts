plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "scot.mclellan.boox"
    compileSdk = 34
    defaultConfig {
        applicationId = "scot.mclellan.boox"
        minSdk = 28
        targetSdk = 34
        versionCode = 3
        versionName = "2.1.0"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

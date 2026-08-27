plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "scot.mclellan.boox"
    compileSdk = 34

    defaultConfig {
        applicationId = "scot.mclellan.boox"
        // Boox Note Max ships Android 11 (API 30); keep a little headroom below
        // that so the same APK sideloads onto older Onyx devices too.
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // The Hub base URL and the device bearer are baked in at build time, the
        // same pattern the other native Hub apps use. Pass the token at build:
        //   ./gradlew assembleDebug -PhubBooxToken=<token>
        // It is never committed to source.
        buildConfigField(
            "String", "HUB_BASE_URL",
            "\"${project.findProperty("hubBaseUrl") ?: "https://dchat.mclellan.scot"}\"",
        )
        buildConfigField(
            "String", "HUB_BOOX_TOKEN",
            "\"${project.findProperty("hubBooxToken") ?: ""}\"",
        )
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Only the lightweight Onyx *device* SDK (not the raw-pen SDK, whose region
    // mapping is broken on this firmware). Used purely to refresh the drawing
    // view in fast e-ink DU mode so pen strokes feel snappy. OCR stays at the hub.
    implementation("com.onyx.android.sdk:onyxsdk-device:1.3.5.2")
}

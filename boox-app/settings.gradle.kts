pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
        // Onyx / Boox pen + device SDK is published here; pulled in at Phase 3.
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "BooxHubPlanner"
include(":app")

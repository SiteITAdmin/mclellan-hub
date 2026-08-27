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
        // Onyx / Boox pen + device SDK (raw e-ink pen capture) lives on Onyx's
        // own Maven repo, not Maven Central.
        maven { url = uri("https://repo.boox.com/repository/maven-public/") }
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "BooxHubPlanner"
include(":app")

// Navega-MX — Android · GPL-3.0-or-later · (C) 2026 Santiago Miguel
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "mx.navega.browser"
    compileSdk = 35

    defaultConfig {
        applicationId = "mx.navega.browser"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "1.0.1"
    }

    sourceSets {
        getByName("main") {
            // El asistente de IA es el mismo código compartido con la versión de escritorio.
            assets.srcDirs("src/main/assets", "../../shared")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // APK de prueba firmado con la clave de depuración para poder instalarlo directamente.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun readXcconfigValue(key: String): String {
    val configFile = rootProject.file("../ios/Secrets.xcconfig")
    if (!configFile.isFile) return ""
    val prefix = "$key ="
    return configFile.readLines()
        .firstOrNull { it.trimStart().startsWith(prefix) }
        ?.substringAfter('=')
        ?.trim()
        ?.trim('"', '\'')
        .orEmpty()
}

fun String.asBuildConfigString(): String = "\"" +
    replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

android {
    namespace = "com.cinevault.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.cinevault.android"
        minSdk = 24
        targetSdk = 36
        versionCode = 6
        versionName = "0.3.0"
        buildConfigField("String", "SERVER_URL", "\"https://cinevault-aleksandr.duckdns.org\"")
        buildConfigField("String", "BASIC_USERNAME", readXcconfigValue("CINEVAULT_BASIC_USERNAME").asBuildConfigString())
        buildConfigField("String", "BASIC_PASSWORD", readXcconfigValue("CINEVAULT_BASIC_PASSWORD").asBuildConfigString())
    }

    buildTypes {
        release {
            // The APK that gets shared: shrunk, optimised and signed with the debug key so that it
            // installs over the debug build and over itself. Debug builds are several times slower.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(rootProject.file("../tools/alloha_ad_filter_extension"))
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

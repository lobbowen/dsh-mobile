pluginManagement {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        // dev.rikka.shizuku:* 与 org.lsposed.hiddenapibypass:* 不在 aliyun 镜像内 → 回退中央仓
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        // Shizuku / hiddenapibypass 的依赖源（ADR-0003：Shizuku 为必备能力）
        google()
        mavenCentral()
    }
}

rootProject.name = "AndroidNodeContainer"
include(":app")
project(":app").projectDir = file("container/app")

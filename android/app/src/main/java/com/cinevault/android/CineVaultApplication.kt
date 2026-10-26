package com.cinevault.android

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import okhttp3.Dispatcher
import okhttp3.OkHttpClient

/**
 * One image loader for the whole app. The posters all come from the same couple of CDN hosts, so the
 * default five connections per host leave a screenful of posters queueing; the disk cache keeps what was
 * seen, and the cache headers are not consulted since a poster's address changes when the poster does.
 */
class CineVaultApplication : Application(), ImageLoaderFactory {
    override fun newImageLoader(): ImageLoader {
        val client = OkHttpClient.Builder()
            .dispatcher(Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 16 })
            .build()
        return ImageLoader.Builder(this)
            .okHttpClient(client)
            .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.25).build() }
            .diskCache { DiskCache.Builder().directory(cacheDir.resolve("images")).maxSizeBytes(256L * 1024 * 1024).build() }
            .respectCacheHeaders(false)
            .crossfade(false)
            .eventListener(object : coil.EventListener {
                override fun onError(request: coil.request.ImageRequest, result: coil.request.ErrorResult) {
                    android.util.Log.w("Coil", "${request.data} failed: ${result.throwable}")
                }
            })
            .build()
    }
}

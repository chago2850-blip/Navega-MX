/*
 * Navega-MX — bloqueador de anuncios y rastreadores por dominio.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package mx.navega.browser

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.util.Collections

object AdBlocker {
    private val domains: MutableSet<String> = Collections.synchronizedSet(HashSet(120_000))
    @Volatile var ready = false
        private set

    fun load(context: Context) {
        Thread {
            for (name in listOf("adblock/base.txt", "adblock/hosts.txt")) {
                try {
                    context.assets.open(name).use { input ->
                        BufferedReader(InputStreamReader(input)).forEachLine { raw ->
                            val line = raw.substringBefore('#').trim()
                            if (line.isEmpty()) return@forEachLine
                            val parts = line.split(Regex("\\s+"))
                            val host = (if (parts.size >= 2) parts[1] else parts[0]).lowercase()
                            if (host.contains('.') && host != "localhost" && host != "0.0.0.0" && !host.endsWith(".local")) {
                                domains.add(host)
                            }
                        }
                    }
                } catch (_: Exception) {
                    // la lista ampliada es opcional
                }
            }
            ready = true
        }.start()
    }

    fun isBlocked(host: String?): Boolean {
        if (!ready || host.isNullOrEmpty()) return false
        var h = host.lowercase()
        while (true) {
            if (domains.contains(h)) return true
            val i = h.indexOf('.')
            if (i < 0 || h.indexOf('.', i + 1) < 0) return false
            h = h.substring(i + 1)
        }
    }

    fun emptyResponse(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

    val count: Int get() = domains.size
}

/*
 * Navega-MX — puente JavaScript ⇄ Android para el asistente de IA.
 * Solo se instala en la vista del asistente (contenido local), nunca en las
 * pestañas que muestran sitios web.
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package mx.navega.browser

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class NavegaBridge(private val activity: MainActivity) {
    private val pool = Executors.newCachedThreadPool()
    private val streams = ConcurrentHashMap<String, HttpURLConnection>()
    private val aborted = ConcurrentHashMap.newKeySet<String>()

    @JavascriptInterface
    fun call(id: String, method: String, argsJson: String) {
        val args = try { JSONObject(argsJson) } catch (e: Exception) { JSONObject() }
        when (method) {
            "fetch" -> pool.execute { doFetch(id, args) }
            "stream" -> pool.execute { doStream(id, args) }
            "abortStream" -> {
                val sid = args.optString("id")
                aborted.add(sid)
                streams[sid]?.let { c -> pool.execute { try { c.disconnect() } catch (_: Exception) {} } }
            }
            else -> activity.runOnUiThread { activity.handleBridgeCall(id, method, args) }
        }
    }

    private fun open(urlStr: String, opts: JSONObject): HttpURLConnection {
        var url = URL(urlStr)
        val method = opts.optString("method", "GET").uppercase()
        val headers = opts.optJSONObject("headers") ?: JSONObject()
        val body = if (opts.has("body") && !opts.isNull("body")) opts.optString("body") else null
        var redirects = 0
        while (true) {
            if (url.protocol != "http" && url.protocol != "https") throw IllegalArgumentException("URL no permitida")
            val c = url.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000
            c.readTimeout = 120000
            c.requestMethod = method
            c.setRequestProperty("User-Agent", activity.userAgent())
            val keys = headers.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                c.setRequestProperty(k, headers.optString(k))
            }
            if (body != null && method != "GET") {
                c.doOutput = true
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            if (code in 300..399 && redirects < 6) {
                val loc = c.getHeaderField("Location") ?: return c
                url = URL(url, loc)
                redirects++
                c.disconnect()
                continue
            }
            return c
        }
    }

    private fun doFetch(id: String, args: JSONObject) {
        try {
            val c = open(args.getString("url"), args.optJSONObject("opts") ?: JSONObject())
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            val sb = StringBuilder()
            stream?.let {
                InputStreamReader(it, Charsets.UTF_8).use { r ->
                    val buf = CharArray(8192)
                    while (sb.length < 3_000_000) {
                        val n = r.read(buf)
                        if (n < 0) break
                        sb.append(buf, 0, n)
                    }
                }
            }
            c.disconnect()
            activity.resolve(id, true, JSONObject().put("status", code).put("text", sb.toString()).put("url", c.url.toString()))
        } catch (e: Exception) {
            activity.resolve(id, false, e.message ?: e.toString())
        }
    }

    private fun doStream(id: String, args: JSONObject) {
        var status = 0
        try {
            val c = open(args.getString("url"), args.optJSONObject("opts") ?: JSONObject())
            streams[id] = c
            status = c.responseCode
            if (status >= 400) {
                val err = c.errorStream?.let { InputStreamReader(it).readText() } ?: ""
                throw RuntimeException("HTTP $status: ${err.take(240)}")
            }
            InputStreamReader(c.inputStream, Charsets.UTF_8).use { r ->
                val buf = CharArray(4096)
                while (!aborted.contains(id)) {
                    val n = r.read(buf)
                    if (n < 0) break
                    activity.streamChunk(id, String(buf, 0, n))
                }
            }
            c.disconnect()
            activity.streamEnd(id, status, null)
        } catch (e: Exception) {
            activity.streamEnd(id, status, if (aborted.contains(id)) null else (e.message ?: e.toString()))
        } finally {
            streams.remove(id)
            aborted.remove(id)
        }
    }
}

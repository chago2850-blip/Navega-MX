/*
 * Navega-MX — almacenamiento local (historial, marcadores, ajustes, sesión).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package mx.navega.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class Entry(val url: String, var title: String, val time: Long)

class Store(context: Context) {
    private val prefs = context.getSharedPreferences("navega", Context.MODE_PRIVATE)

    var adblock: Boolean
        get() = prefs.getBoolean("adblock", true)
        set(v) = prefs.edit().putBoolean("adblock", v).apply()

    var searchEngine: String
        get() = prefs.getString("searchEngine", "duckduckgo") ?: "duckduckgo"
        set(v) = prefs.edit().putString("searchEngine", v).apply()

    var searxUrl: String
        get() = prefs.getString("searxUrl", "") ?: ""
        set(v) = prefs.edit().putString("searxUrl", v).apply()

    var homepage: String
        get() = prefs.getString("homepage", "navega://inicio") ?: "navega://inicio"
        set(v) = prefs.edit().putString("homepage", v).apply()

    var desktopMode: Boolean
        get() = prefs.getBoolean("desktopMode", false)
        set(v) = prefs.edit().putBoolean("desktopMode", v).apply()

    var whitelist: Set<String>
        get() = prefs.getStringSet("whitelist", emptySet()) ?: emptySet()
        set(v) = prefs.edit().putStringSet("whitelist", v).apply()

    private fun readList(key: String): MutableList<Entry> {
        val out = mutableListOf<Entry>()
        try {
            val arr = JSONArray(prefs.getString(key, "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(Entry(o.optString("url"), o.optString("title"), o.optLong("time")))
            }
        } catch (_: Exception) {
        }
        return out
    }

    private fun writeList(key: String, list: List<Entry>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("url", it.url).put("title", it.title).put("time", it.time)) }
        prefs.edit().putString(key, arr.toString()).apply()
    }

    fun history(): MutableList<Entry> = readList("history")

    fun addHistory(url: String, title: String) {
        if (!url.startsWith("http")) return
        val list = history().filter { it.url != url }.toMutableList()
        list.add(0, Entry(url, title, System.currentTimeMillis()))
        writeList("history", list.take(2000))
    }

    fun updateHistoryTitle(url: String, title: String) {
        val list = history()
        val e = list.firstOrNull { it.url == url } ?: return
        e.title = title
        writeList("history", list)
    }

    fun clearHistory() = writeList("history", emptyList())

    fun bookmarks(): MutableList<Entry> = readList("bookmarks")

    fun isBookmarked(url: String) = bookmarks().any { it.url == url }

    fun toggleBookmark(url: String, title: String): Boolean {
        val list = bookmarks()
        return if (list.any { it.url == url }) {
            writeList("bookmarks", list.filter { it.url != url })
            false
        } else {
            list.add(0, Entry(url, title, System.currentTimeMillis()))
            writeList("bookmarks", list)
            true
        }
    }

    fun removeBookmark(url: String) = writeList("bookmarks", bookmarks().filter { it.url != url })

    fun saveSession(urls: List<String>, active: Int) {
        val arr = JSONArray()
        urls.forEach { arr.put(it) }
        prefs.edit().putString("session", arr.toString()).putInt("sessionActive", active).apply()
    }

    fun session(): Pair<List<String>, Int> {
        val list = mutableListOf<String>()
        try {
            val arr = JSONArray(prefs.getString("session", "[]"))
            for (i in 0 until arr.length()) list.add(arr.getString(i))
        } catch (_: Exception) {
        }
        return Pair(list, prefs.getInt("sessionActive", 0))
    }
}

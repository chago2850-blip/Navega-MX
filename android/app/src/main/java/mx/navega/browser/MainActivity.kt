/*
 * Navega-MX — navegador con IA de código abierto para Android.
 * Copyright (C) 2026 Santiago Miguel
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. This program is distributed WITHOUT ANY WARRANTY.
 * See <https://www.gnu.org/licenses/>.
 */
package mx.navega.browser

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class MainActivity : AppCompatActivity() {

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val INICIO = "https://$ASSET_HOST/assets/navega/ui/inicio.html"
        const val ASSISTANT = "https://$ASSET_HOST/assets/navega/ui/assistant.html"
        private const val REQ_AUDIO = 41
        private const val CHANNEL = "navega_tareas"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    }

    inner class Tab(val id: String, val web: WebView) {
        @Volatile var url: String = ""
        var title: String = "Nueva pestaña"
        var loading = false
        var blocked = 0
        val waiters = mutableListOf<() -> Unit>()
    }

    lateinit var store: Store
    private lateinit var assetLoader: WebViewAssetLoader
    private val tabs = mutableListOf<Tab>()
    private var active: Tab? = null
    private var tabSeq = 0
    private val main = Handler(Looper.getMainLooper())

    private lateinit var root: LinearLayout
    private lateinit var urlBar: EditText
    private lateinit var progress: ProgressBar
    private lateinit var tabsHost: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var sheet: FrameLayout
    private lateinit var dim: View
    private lateinit var tabCount: TextView
    private lateinit var shieldCount: TextView
    private lateinit var btnBack: ImageButton
    private lateinit var btnForward: ImageButton

    private lateinit var assistant: WebView
    private var assistantReady = false
    private val pendingEvents = mutableListOf<String>()
    private var sheetExpanded = false

    private var tts: TextToSpeech? = null
    private var recognizer: SpeechRecognizer? = null
    private var pendingListenId: String? = null

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    @Volatile private var mobileUa: String = ""

    /* ============================================================ ciclo de vida */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        store = Store(this)
        AdBlocker.load(this)
        mobileUa = WebSettings.getDefaultUserAgent(this).replace("; wv", "").replace(Regex("Version/\\S+ "), "")

        root = findViewById(R.id.root)
        urlBar = findViewById(R.id.urlBar)
        progress = findViewById(R.id.progress)
        tabsHost = findViewById(R.id.tabsHost)
        content = findViewById(R.id.content)
        sheet = findViewById(R.id.assistantSheet)
        dim = findViewById(R.id.dim)
        tabCount = findViewById(R.id.tabCount)
        shieldCount = findViewById(R.id.shieldCount)
        btnBack = findViewById(R.id.btnBack)
        btnForward = findViewById(R.id.btnForward)

        WindowInsetsControllerCompat(window, root).isAppearanceLightStatusBars = false
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        setupAssistant()
        setupControls()

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale("es", "MX")
        }

        val (urls, act) = store.session()
        if (urls.isNotEmpty()) {
            urls.forEach { createTab(it, activate = false) }
            activate(tabs[act.coerceIn(0, tabs.size - 1)])
        }
        if (!handleIntent(intent) && tabs.isEmpty()) createTab(store.homepage)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> customCallback?.onCustomViewHidden()
                    sheet.visibility == View.VISIBLE -> hideAssistant()
                    active?.web?.canGoBack() == true -> active?.web?.goBack()
                    tabs.size > 1 -> active?.let { closeTab(it) }
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onPause() {
        super.onPause()
        store.saveSession(tabs.map { if (it.url.startsWith(INICIO)) "navega://inicio" else it.url }, tabs.indexOf(active).coerceAtLeast(0))
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        tts?.shutdown()
        recognizer?.destroy()
        super.onDestroy()
    }

    private fun handleIntent(intent: Intent?): Boolean {
        if (intent == null) return false
        when (intent.action) {
            Intent.ACTION_VIEW -> {
                val u = intent.dataString ?: return false
                createTab(u); return true
            }
            Intent.ACTION_WEB_SEARCH -> {
                val q = intent.getStringExtra("query") ?: return false
                if (tabs.isEmpty()) createTab(store.homepage)
                askAssistant(q, "buscar"); return true
            }
            Intent.ACTION_SEND -> {
                val t = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return false
                if (tabs.isEmpty()) createTab(store.homepage)
                val link = Regex("https?://\\S+").find(t)?.value
                if (link != null && link.length > t.length - 5) createTab(link) else askAssistant(t, "buscar")
                return true
            }
        }
        return false
    }

    /* ============================================================ interfaz */

    private fun setupControls() {
        findViewById<ImageButton>(R.id.btnHome).setOnClickListener { load(store.homepage) }
        findViewById<ImageButton>(R.id.btnReload).setOnClickListener {
            val t = active ?: return@setOnClickListener
            if (t.loading) t.web.stopLoading() else t.web.reload()
        }
        btnBack.setOnClickListener { active?.web?.let { if (it.canGoBack()) it.goBack() } }
        btnForward.setOnClickListener { active?.web?.let { if (it.canGoForward()) it.goForward() } }
        findViewById<ImageButton>(R.id.btnAssistant).setOnClickListener {
            if (sheet.visibility == View.VISIBLE) hideAssistant() else { showAssistant(false); sendEvent("focus", JSONObject()) }
        }
        findViewById<View>(R.id.btnTabs).setOnClickListener { showTabs() }
        findViewById<ImageButton>(R.id.btnMenu).setOnClickListener { showMenu(it) }
        findViewById<ImageButton>(R.id.btnShield).setOnClickListener { showShield() }
        dim.setOnClickListener { hideAssistant() }
        urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO || (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)) {
                submit(urlBar.text.toString().trim()); true
            } else false
        }
        urlBar.setOnFocusChangeListener { _, has -> if (!has) showUrl(active) }
    }

    private fun hideKeyboard() {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(urlBar.windowToken, 0)
        urlBar.clearFocus()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun isQuestion(t: String): Boolean {
        if (t.endsWith("?") || t.startsWith("¿")) return true
        val q = Regex("^(qu[eé]|c[oó]mo|cu[aá]l(es)?|cu[aá]nt[oa]s?|por ?qu[eé]|qui[eé]n(es)?|d[oó]nde|cu[aá]ndo|explica|resume|compara|dime|what|how|why|who|which|when|where)\\b", RegexOption.IGNORE_CASE)
        return q.containsMatchIn(t) && t.split(Regex("\\s+")).size >= 3
    }

    private fun looksLikeUrl(t: String): Boolean {
        if (Regex("^(https?|about|navega):", RegexOption.IGNORE_CASE).containsMatchIn(t)) return true
        if (t.contains(' ')) return false
        return Regex("^localhost(:\\d+)?(/.*)?$|^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?(/.*)?$|^[\\w-]+(\\.[\\w-]+)*\\.[a-z]{2,}(:\\d+)?(/.*)?$", RegexOption.IGNORE_CASE).matches(t)
    }

    fun searchUrl(q: String): String {
        val e = Uri.encode(q)
        return when (store.searchEngine) {
            "google" -> "https://www.google.com/search?q=$e"
            "bing" -> "https://www.bing.com/search?q=$e"
            "brave" -> "https://search.brave.com/search?q=$e"
            "startpage" -> "https://www.startpage.com/do/search?q=$e"
            "searxng" -> if (store.searxUrl.isNotBlank()) store.searxUrl.trimEnd('/') + "/search?q=$e" else "https://duckduckgo.com/?kl=mx-es&q=$e"
            else -> "https://duckduckgo.com/?kl=mx-es&q=$e"
        }
    }

    private fun submit(text: String) {
        if (text.isEmpty()) return
        hideKeyboard()
        when {
            text.startsWith("?") -> askAssistant(text.removePrefix("?").trim(), "buscar")
            looksLikeUrl(text) -> load(if (Regex("^[a-z]+:", RegexOption.IGNORE_CASE).containsMatchIn(text)) text
                else if (text.startsWith("localhost") || Regex("^\\d").containsMatchIn(text)) "http://$text" else "https://$text")
            isQuestion(text) -> askAssistant(text, "buscar")
            else -> load(searchUrl(text))
        }
    }

    private fun resolveUrl(u: String): String =
        if (u.startsWith("navega://inicio") || u.isBlank()) INICIO else u

    private fun load(url: String) {
        val t = active ?: createTab(url)
        t.web.loadUrl(resolveUrl(url))
    }

    private fun showUrl(t: Tab?) {
        if (t == null || urlBar.hasFocus()) return
        urlBar.setText(if (t.url.startsWith(INICIO) || t.url.isEmpty()) "" else t.url)
    }

    private fun updateNav() {
        val w = active?.web
        btnBack.alpha = if (w?.canGoBack() == true) 1f else 0.35f
        btnForward.alpha = if (w?.canGoForward() == true) 1f else 0.35f
        tabCount.text = if (tabs.size > 99) ":D" else tabs.size.toString()
        updateShield()
    }

    private fun updateShield() {
        val t = active
        val on = store.adblock && t != null && !whitelisted(t.url)
        shieldCount.text = if (on && t != null && t.blocked > 0) (if (t.blocked > 99) "99+" else t.blocked.toString()) else ""
        findViewById<ImageButton>(R.id.btnShield).alpha = if (on) 1f else 0.4f
    }

    private fun hostOf(u: String): String = try { Uri.parse(u).host?.removePrefix("www.") ?: "" } catch (e: Exception) { "" }
    private fun whitelisted(u: String): Boolean {
        val h = hostOf(u)
        return h.isNotEmpty() && store.whitelist.any { h == it || h.endsWith(".$it") }
    }

    fun userAgent(): String = if (store.desktopMode) DESKTOP_UA else mobileUa

    /* ============================================================ pestañas */

    @SuppressLint("SetJavaScriptEnabled")
    private fun createTab(url: String?, activate: Boolean = true): Tab {
        val web = WebView(this)
        val tab = Tab("t" + (++tabSeq) + "_" + System.currentTimeMillis().toString(36), web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            mediaPlaybackRequiresUserGesture = true
            userAgentString = userAgent()
        }
        web.setBackgroundColor(Color.WHITE)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webViewClient = TabClient(tab)
        web.webChromeClient = TabChrome(tab)
        web.setDownloadListener { dlUrl, ua, cd, mime, _ -> download(dlUrl, ua, cd, mime) }
        web.visibility = View.INVISIBLE
        tabsHost.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        tabs.add(tab)
        if (url != null) {
            tab.url = resolveUrl(url)
            web.loadUrl(tab.url)
        }
        if (activate) activate(tab) else updateNav()
        return tab
    }

    private fun activate(t: Tab) {
        active = t
        tabs.forEach { it.web.visibility = if (it == t) View.VISIBLE else View.INVISIBLE }
        t.web.bringToFront()
        showUrl(t)
        progress.visibility = if (t.loading) View.VISIBLE else View.INVISIBLE
        updateNav()
        sendEvent("tabChanged", JSONObject())
    }

    private fun closeTab(t: Tab) {
        val i = tabs.indexOf(t)
        tabs.remove(t)
        tabsHost.removeView(t.web)
        t.web.destroy()
        if (tabs.isEmpty()) createTab(store.homepage)
        else if (active == t) activate(tabs[(i).coerceAtMost(tabs.size - 1)])
        updateNav()
    }

    private fun tabById(id: String?): Tab? = tabs.firstOrNull { it.id == id }

    private inner class TabClient(val tab: Tab) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            assetLoader.shouldInterceptRequest(request.url)?.let { return it }
            if (store.adblock && !request.isForMainFrame && AdBlocker.isBlocked(request.url.host) && !whitelisted(tab.url)) {
                tab.blocked++
                if (tab == active) main.post { updateShield() }
                return AdBlocker.emptyResponse()
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when (uri.scheme?.lowercase()) {
                "http", "https" -> return false
                "navega-ask" -> {
                    val q = uri.getQueryParameter("q") ?: ""
                    val m = uri.getQueryParameter("m") ?: "buscar"
                    if (q.isNotBlank()) askAssistant(q, m)
                    return true
                }
                "navega" -> { view.loadUrl(resolveUrl(uri.toString())); return true }
                "intent" -> {
                    try {
                        val i = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                        try { startActivity(i) } catch (e: ActivityNotFoundException) {
                            i.getStringExtra("browser_fallback_url")?.let { view.loadUrl(it) }
                        }
                    } catch (_: Exception) {}
                    return true
                }
                else -> {
                    try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) { toast("No hay una app para abrir este enlace") }
                    return true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            tab.loading = true
            tab.url = url
            tab.blocked = 0
            if (tab == active) { showUrl(tab); progress.visibility = View.VISIBLE; updateNav() }
        }

        override fun onPageFinished(view: WebView, url: String) {
            tab.loading = false
            tab.url = url
            view.title?.let { if (it.isNotBlank()) tab.title = it }
            store.addHistory(url, tab.title)
            if (url.startsWith(INICIO)) {
                val arr = JSONArray()
                store.bookmarks().take(12).forEach { arr.put(JSONObject().put("url", it.url).put("title", it.title)) }
                view.evaluateJavascript("window.navegaSetTiles && window.navegaSetTiles($arr)", null)
            }
            val w = tab.waiters.toList()
            tab.waiters.clear()
            w.forEach { it() }
            if (tab == active) { progress.visibility = View.INVISIBLE; showUrl(tab); updateNav() }
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.url = url
            if (tab == active) { showUrl(tab); updateNav() }
        }
    }

    private inner class TabChrome(val tab: Tab) : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (tab == active) {
                progress.progress = newProgress
                progress.visibility = if (newProgress < 100) View.VISIBLE else View.INVISIBLE
            }
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (title.isNullOrBlank()) return
            tab.title = title
            store.updateHistoryTitle(tab.url, title)
            if (tab == active) sendEvent("tabChanged", JSONObject())
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
            val t = createTab(null, activate = true)
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = t.web
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            tabs.firstOrNull { it.web == window }?.let { closeTab(it) }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) { callback.onCustomViewHidden(); return }
            customView = view
            customCallback = callback
            (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            WindowInsetsControllerCompat(window, view).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        override fun onHideCustomView() {
            val v = customView ?: return
            (window.decorView as FrameLayout).removeView(v)
            WindowInsetsControllerCompat(window, root).show(WindowInsetsCompat.Type.systemBars())
            customView = null
            customCallback?.onCustomViewHidden()
            customCallback = null
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                filePicker.launch(params.createIntent())
                true
            } catch (e: Exception) {
                fileCallback = null
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }

    private fun download(url: String, ua: String?, cd: String?, mime: String?) {
        try {
            val name = URLUtil.guessFileName(url, cd, mime)
            val req = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mime)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                addRequestHeader("User-Agent", ua ?: userAgent())
                setTitle(name)
                setDescription("Navega-MX")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast("Descargando $name")
        } catch (e: Exception) {
            toast("No se pudo descargar: ${e.message}")
        }
    }

    /* ============================================================ diálogos */

    private fun showTabs() {
        val list = ListView(this)
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pestañas (${tabs.size})")
            .setView(list)
            .setPositiveButton("Nueva pestaña") { _, _ -> createTab(store.homepage) }
            .setNeutralButton("Cerrar todas") { _, _ -> tabs.toList().forEach { closeTab(it) } }
            .create()
        val adapter = object : BaseAdapter() {
            override fun getCount() = tabs.size
            override fun getItem(p: Int) = tabs[p]
            override fun getItemId(p: Int) = p.toLong()
            override fun getView(p: Int, convert: View?, parent: ViewGroup?): View {
                val t = tabs[p]
                val row = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(36, 22, 12, 22)
                    if (t == active) setBackgroundColor(0x225B8CFF)
                }
                val texts = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
                texts.addView(TextView(this@MainActivity).apply {
                    text = t.title; textSize = 15f; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                })
                texts.addView(TextView(this@MainActivity).apply {
                    text = if (t.url.startsWith(INICIO)) "Nueva pestaña" else hostOf(t.url)
                    textSize = 12f; alpha = 0.6f; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
                })
                row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                val adapterRef = this
                row.addView(ImageButton(this@MainActivity).apply {
                    setImageResource(R.drawable.ic_close)
                    setColorFilter(0xFF9AA6D6.toInt())
                    background = null
                    contentDescription = "Cerrar"
                    setOnClickListener { closeTab(t); adapterRef.notifyDataSetChanged(); if (tabs.isEmpty()) dialog.dismiss() }
                })
                row.setOnClickListener { activate(t); dialog.dismiss() }
                return row
            }
        }
        list.adapter = adapter
        dialog.show()
    }

    private fun showMenu(anchor: View) {
        val t = active
        val pm = PopupMenu(this, anchor)
        val m = pm.menu
        m.add(0, 1, 0, "Nueva pestaña")
        m.add(0, 2, 1, if (t != null && store.isBookmarked(t.url)) "Quitar de marcadores" else "Agregar a marcadores")
        m.add(0, 3, 2, "Marcadores")
        m.add(0, 4, 3, "Historial")
        m.add(0, 5, 4, "Resumir esta página con IA")
        m.add(0, 6, 5, "Agente: hacer una tarea…")
        m.add(0, 7, 6, "Buscar en la página")
        m.add(0, 8, 7, "Compartir")
        m.add(0, 9, 8, "Sitio de escritorio").apply { isCheckable = true; isChecked = store.desktopMode }
        m.add(0, 10, 9, "Ajustes de IA y navegador")
        m.add(0, 11, 10, "Borrar datos de navegación")
        m.add(0, 12, 11, "Acerca de Navega-MX")
        pm.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> createTab(store.homepage)
                2 -> t?.let { if (!it.url.startsWith(INICIO)) toast(if (store.toggleBookmark(it.url, it.title)) "Agregado a marcadores" else "Marcador eliminado") }
                3 -> showEntries("Marcadores", store.bookmarks(), true)
                4 -> showEntries("Historial", store.history().take(300), false)
                5 -> { showAssistant(false); sendEvent("shortcut", JSONObject().put("name", "resumir")) }
                6 -> { showAssistant(false); sendEvent("ask", JSONObject().put("text", "").put("mode", "agente")) }
                7 -> findInPage()
                8 -> t?.let {
                    startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, it.url).putExtra(Intent.EXTRA_SUBJECT, it.title), "Compartir"))
                }
                9 -> {
                    store.desktopMode = !store.desktopMode
                    tabs.forEach { tb -> tb.web.settings.userAgentString = userAgent() }
                    active?.web?.reload()
                }
                10 -> { showAssistant(true); sendEvent("view", JSONObject().put("name", "settings")) }
                11 -> AlertDialog.Builder(this).setTitle("Borrar datos")
                    .setMessage("Se borrarán el historial, la caché y las cookies (cerrará tus sesiones).")
                    .setPositiveButton("Borrar") { _, _ ->
                        store.clearHistory()
                        tabs.forEach { tb -> tb.web.clearCache(true) }
                        CookieManager.getInstance().removeAllCookies(null)
                        android.webkit.WebStorage.getInstance().deleteAllData()
                        toast("Datos borrados")
                    }.setNegativeButton("Cancelar", null).show()
                12 -> about()
            }
            true
        }
        pm.show()
    }

    private fun showEntries(title: String, list: List<Entry>, bookmarks: Boolean) {
        if (list.isEmpty()) { toast("$title: vacío"); return }
        val items = list.map { (it.title.ifBlank { it.url }) + "\n" + hostOf(it.url) }.toTypedArray()
        val b = AlertDialog.Builder(this).setTitle(title)
            .setItems(items) { _, i -> createTab(list[i].url) }
            .setNegativeButton("Cerrar", null)
        if (!bookmarks) b.setNeutralButton("Borrar historial") { _, _ -> store.clearHistory(); toast("Historial borrado") }
        else b.setNeutralButton("Quitar marcador actual") { _, _ -> active?.let { store.removeBookmark(it.url) } }
        b.show()
    }

    private fun findInPage() {
        val w = active?.web ?: return
        val input = EditText(this).apply { hint = "Texto a buscar"; setSingleLine() }
        w.setFindListener { ord, total, done -> if (done) toast(if (total == 0) "Sin resultados" else "${ord + 1} de $total") }
        AlertDialog.Builder(this).setTitle("Buscar en la página").setView(input)
            .setPositiveButton("Buscar") { _, _ -> w.findAllAsync(input.text.toString()) }
            .setNeutralButton("Siguiente") { _, _ -> w.findNext(true) }
            .setNegativeButton("Limpiar") { _, _ -> w.clearMatches() }
            .show()
    }

    private fun showShield() {
        val t = active ?: return
        val h = hostOf(t.url)
        val wl = whitelisted(t.url)
        val opts = mutableListOf<String>()
        opts.add(if (store.adblock) "Desactivar protección global" else "Activar protección global")
        if (h.isNotEmpty()) opts.add(if (wl) "Bloquear anuncios en $h" else "Permitir anuncios en $h")
        AlertDialog.Builder(this)
            .setTitle("Bloqueador: ${t.blocked} bloqueados aquí")
            .setItems(opts.toTypedArray()) { _, i ->
                if (i == 0) store.adblock = !store.adblock
                else store.whitelist = if (wl) store.whitelist.filter { it != h }.toSet() else store.whitelist + h
                t.web.reload()
                updateShield()
            }
            .setNegativeButton("Cerrar", null)
            .show()
    }

    private fun about() {
        AlertDialog.Builder(this)
            .setTitle("Navega-MX ${BuildConfig.VERSION_NAME}")
            .setMessage(
                "Navegador web con inteligencia artificial de código abierto.\n\n" +
                    "Licencia: GNU GPL v3 o posterior.\n" +
                    "Desarrollador: Santiago Miguel\n\n" +
                    "Bloqueador: ${AdBlocker.count} dominios en la lista.\n" +
                    "github.com/chago2850-blip/Navega-MX"
            )
            .setPositiveButton("Código fuente") { _, _ -> createTab("https://github.com/chago2850-blip/Navega-MX") }
            .setNegativeButton("Cerrar", null)
            .show()
    }

    /* ============================================================ asistente */

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun setupAssistant() {
        assistant = WebView(this)
        assistant.setBackgroundColor(0xFF0D1230.toInt())
        assistant.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
        }
        assistant.addJavascriptInterface(NavegaBridge(this), "AndroidNavega")
        assistant.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == ASSET_HOST) return false
                hideAssistant()
                createTab(request.url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                assistantReady = true
                pendingEvents.forEach { assistant.evaluateJavascript(it, null) }
                pendingEvents.clear()
            }
        }
        assistant.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { filePicker.launch(params.createIntent()); true } catch (e: Exception) { fileCallback = null; false }
            }
        }
        sheet.addView(assistant, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        assistant.loadUrl(ASSISTANT)
    }

    private fun showAssistant(expanded: Boolean) {
        sheetExpanded = expanded
        val lp = sheet.layoutParams as FrameLayout.LayoutParams
        lp.height = if (expanded || content.height == 0) ViewGroup.LayoutParams.MATCH_PARENT else (content.height * 0.7).toInt()
        lp.gravity = Gravity.BOTTOM
        sheet.layoutParams = lp
        dim.visibility = if (expanded) View.GONE else View.VISIBLE
        if (sheet.visibility != View.VISIBLE) {
            sheet.visibility = View.VISIBLE
            sheet.translationY = 300f
            sheet.alpha = 0f
            sheet.animate().translationY(0f).alpha(1f).setDuration(180).start()
        }
        hideKeyboard()
    }

    private fun hideAssistant() {
        sheet.visibility = View.GONE
        dim.visibility = View.GONE
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(assistant.windowToken, 0)
    }

    private fun askAssistant(text: String, mode: String) {
        showAssistant(mode == "buscar")
        sendEvent("ask", JSONObject().put("text", text).put("mode", mode).put("newThread", mode == "buscar"))
    }

    private fun js(code: String) {
        main.post {
            if (assistantReady) assistant.evaluateJavascript(code, null) else pendingEvents.add(code)
        }
    }

    private fun sendEvent(name: String, data: JSONObject) {
        js("window.NavegaHost && NavegaHost._event(${JSONObject.quote(name)}, $data)")
    }

    fun resolve(id: String, ok: Boolean, value: Any?) {
        val payload = JSONObject().put("v", value ?: JSONObject.NULL)
        js("NavegaHost._resolve(${JSONObject.quote(id)}, $ok, $payload)")
    }

    fun streamChunk(id: String, text: String) {
        js("NavegaHost._chunk(${JSONObject.quote(id)}, ${JSONObject.quote(text)})")
    }

    fun streamEnd(id: String, status: Int, error: String?) {
        js("NavegaHost._end(${JSONObject.quote(id)}, $status, ${if (error == null) "null" else JSONObject.quote(error)})")
    }

    private fun tabJson(t: Tab) = JSONObject()
        .put("id", t.id).put("url", t.url).put("title", t.title).put("active", t == active)

    /** Llamadas del asistente que deben ejecutarse en el hilo principal. */
    fun handleBridgeCall(id: String, method: String, a: JSONObject) {
        try {
            when (method) {
                "appInfo" -> resolve(id, true, JSONObject().put("version", BuildConfig.VERSION_NAME).put("platform", "android").put("sdk", Build.VERSION.SDK_INT))
                "getActiveTab" -> resolve(id, true, active?.let { tabJson(it) })
                "listTabs" -> resolve(id, true, JSONArray().also { arr -> tabs.forEach { arr.put(tabJson(it)) } })
                "runInTab" -> {
                    val t = tabById(a.optString("tabId"))
                    if (t == null) resolve(id, false, "La pestaña ya no existe")
                    else t.web.evaluateJavascript(a.optString("code")) { raw -> resolve(id, true, raw ?: "null") }
                }
                "navigate" -> {
                    val t = tabById(a.optString("tabId"))
                    if (t == null) resolve(id, false, "La pestaña ya no existe")
                    else {
                        t.loading = true
                        t.web.loadUrl(resolveUrl(a.optString("url")))
                        main.postDelayed({ resolve(id, true, null) }, 300)
                    }
                }
                "openTab" -> {
                    val bg = a.optBoolean("background")
                    val t = createTab(a.optString("url").ifBlank { store.homepage }, activate = !bg)
                    if (!bg) hideAssistantIfCovering()
                    resolve(id, true, t.id)
                }
                "activateTab" -> { tabById(a.optString("tabId"))?.let { activate(it) }; resolve(id, true, null) }
                "closeTab" -> { tabById(a.optString("tabId"))?.let { closeTab(it) }; resolve(id, true, null) }
                "goBack" -> { tabById(a.optString("tabId"))?.web?.let { if (it.canGoBack()) it.goBack() }; resolve(id, true, null) }
                "waitForLoad" -> {
                    val t = tabById(a.optString("tabId"))
                    if (t == null || !t.loading) resolve(id, true, null)
                    else {
                        var done = false
                        val finish: () -> Unit = { if (!done) { done = true; resolve(id, true, null) } }
                        t.waiters.add(finish)
                        main.postDelayed({ finish() }, a.optLong("ms", 15000))
                    }
                }
                "listen" -> startListening(id)
                "speak" -> { tts?.speak(a.optString("text"), TextToSpeech.QUEUE_FLUSH, null, "navega"); resolve(id, true, null) }
                "stopSpeaking" -> { tts?.stop(); resolve(id, true, null) }
                "transcribe" -> resolve(id, false, "En Android se usa el reconocimiento de voz del sistema.")
                "getHistory" -> resolve(id, true, JSONArray().also { arr ->
                    store.history().take(a.optInt("n", 30)).forEach { arr.put(JSONObject().put("url", it.url).put("title", it.title).put("time", it.time)) }
                })
                "setHostSettings" -> {
                    val s = a.optJSONObject("settings") ?: JSONObject()
                    if (s.has("adblock")) store.adblock = s.optBoolean("adblock", true)
                    if (s.has("searchEngine")) store.searchEngine = s.optString("searchEngine")
                    if (s.has("searxUrl")) store.searxUrl = s.optString("searxUrl")
                    if (s.has("homepage")) store.homepage = s.optString("homepage").ifBlank { "navega://inicio" }
                    updateShield()
                    resolve(id, true, true)
                }
                "panel" -> {
                    when (a.optString("action")) {
                        "close" -> hideAssistant()
                        "open" -> if (sheet.visibility != View.VISIBLE) showAssistant(sheetExpanded)
                        "expand" -> showAssistant(true)
                        "collapse" -> showAssistant(false)
                    }
                    resolve(id, true, null)
                }
                "notify" -> { notifyUser(a.optString("title"), a.optString("body")); resolve(id, true, null) }
                else -> resolve(id, false, "Función no disponible: $method")
            }
        } catch (e: Exception) {
            resolve(id, false, e.message ?: e.toString())
        }
    }

    private fun hideAssistantIfCovering() {
        // Al abrir una pestaña visible para el agente, deja ver la página reduciendo el panel.
        if (sheet.visibility == View.VISIBLE && sheetExpanded) showAssistant(false)
    }

    private fun notifyUser(title: String, body: String) {
        toast(title)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 77)
            return
        }
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Tareas de Navega-MX", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_spark)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(this).notify((System.currentTimeMillis() % 100000).toInt(), n) } catch (_: SecurityException) {}
    }

    /* ============================================================ voz */

    private fun startListening(id: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingListenId = id
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            resolve(id, false, "El reconocimiento de voz no está disponible en este dispositivo.")
            return
        }
        recognizer?.destroy()
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        var done = false
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { toast("Escuchando…") }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                if (done) return
                done = true
                resolve(id, false, "No te escuché bien (código $error). Intenta de nuevo.")
            }
            override fun onResults(results: Bundle?) {
                if (done) return
                done = true
                val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                resolve(id, true, list?.firstOrNull() ?: "")
            }
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-MX")
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        r.startListening(intent)
    }

    @Deprecated("Usa la API de resultados de actividad; se mantiene por compatibilidad")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_AUDIO) {
            val id = pendingListenId ?: return
            pendingListenId = null
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) startListening(id)
            else resolve(id, false, "Necesito permiso de micrófono para el modo de voz.")
        }
    }
}

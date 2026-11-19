/*
 * Navega-MX — modo de voz (dictado y lectura en voz alta).
 * Copyright (C) 2026 Santiago Miguel
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Android: reconocimiento y voz nativos del sistema.
 * Escritorio: graba con el micrófono y transcribe con un servidor Whisper de
 * código abierto compatible con la API /v1/audio/transcriptions
 * (whisper.cpp server, Speaches/faster-whisper, LocalAI…).
 */
import { host } from './host.js';

let recorder = null;

export function canListen(s) {
  return host.platform === 'android' || !!s.sttUrl;
}

/** Comienza a escuchar. Devuelve {stop(): Promise<string>} o, en Android, una promesa con el texto. */
export async function startListening(s, onLevel) {
  if (host.platform === 'android') {
    return { stop: null, result: host.listen() };
  }
  if (!s.sttUrl) throw new Error('Para dictar por voz configura en Ajustes un servidor de transcripción Whisper (por ejemplo whisper.cpp o Speaches).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let ctx, raf;
  if (onLevel) {
    ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const loop = () => { an.getByteFrequencyData(data); onLevel(data.reduce((a, b) => a + b, 0) / data.length / 128); raf = requestAnimationFrame(loop); };
    loop();
  }
  recorder.start();
  return {
    result: null,
    stop: () => new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (raf) cancelAnimationFrame(raf);
        if (ctx) ctx.close();
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const b64 = await blobToBase64(blob);
          const text = await host.transcribe(b64, blob.type, { url: s.sttUrl, model: s.sttModel, language: 'es' });
          resolve(String(text || '').trim());
        } catch (e) { reject(e); }
      };
      recorder.stop();
    }),
  };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export function speak(text) {
  const plain = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/[#*_`>|\[\]]/g, '').replace(/\(https?:[^)]+\)/g, '').slice(0, 4000);
  if (host.platform === 'android') return host.speak(plain);
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = 'es-MX';
  const v = speechSynthesis.getVoices().find((x) => /^es/i.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (host.platform === 'android') return host.stopSpeaking && host.stopSpeaking();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

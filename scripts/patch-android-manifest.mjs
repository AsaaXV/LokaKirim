import fs from 'node:fs';
import path from 'node:path';

const androidRoot = path.resolve(process.cwd(), 'src-tauri/gen/android');
const manifestPath = path.join(androidRoot, 'app/src/main/AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error(`AndroidManifest.xml tidak ditemukan di: ${manifestPath}`);
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, 'utf8');

const requiredPermissions = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.WAKE_LOCK',
];

for (const perm of requiredPermissions) {
  if (!xml.includes(perm)) {
    xml = xml.replace(
      '<application',
      `    <uses-permission android:name="${perm}" />\n    <application`
    );
  }
}

const optionalFeatures = [
  'android.hardware.camera',
  'android.hardware.microphone',
];

for (const feat of optionalFeatures) {
  if (!xml.includes(feat)) {
    xml = xml.replace(
      '<application',
      `    <uses-feature android:name="${feat}" android:required="false" />\n    <application`
    );
  }
}

if (!xml.includes('android:usesCleartextTraffic')) {
  xml = xml.replace(
    '<application',
    '<application\n        android:usesCleartextTraffic="true"'
  );
} else {
  xml = xml.replace(
    /android:usesCleartextTraffic="[^"]*"/,
    'android:usesCleartextTraffic="true"'
  );
}

fs.writeFileSync(manifestPath, xml, 'utf8');
console.log('AndroidManifest.xml berhasil dipatch untuk Wi-Fi LAN, Audio/Video Call & izin perangkat.');

// Pastikan MainActivity.kt meminta izin runtime CAMERA & RECORD_AUDIO pada Android 6+
function findFileRecursive(dir, targetName) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFileRecursive(full, targetName);
      if (hit) return hit;
    } else if (entry.name === targetName) {
      return full;
    }
  }
  return null;
}

const mainActivityPath = findFileRecursive(
  path.join(androidRoot, 'app/src/main'),
  'MainActivity.kt'
);

if (mainActivityPath && fs.existsSync(mainActivityPath)) {
  const originalKt = fs.readFileSync(mainActivityPath, 'utf8');
  if (!originalKt.includes('RECORD_AUDIO')) {
    const pkgMatch = /^\s*package\s+([^\s]+)/m.exec(originalKt);
    const pkgName = pkgMatch ? pkgMatch[1] : 'com.lokakirim.app';
    const patchedKt = `package ${pkgName}

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val needed = listOf(
      Manifest.permission.RECORD_AUDIO,
      Manifest.permission.CAMERA
    ).filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }

    if (needed.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, needed.toTypedArray(), 1001)
    }
  }
}
`;
    fs.writeFileSync(mainActivityPath, patchedKt, 'utf8');
    console.log(`MainActivity.kt berhasil dipatch untuk izin runtime mikrofon & kamera (${mainActivityPath}).`);
  }
}

// Pastikan compileSdk & targetSdk di build.gradle.kts cocok dengan SDK yang terpasang
const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const platformsDir = sdkRoot ? path.join(sdkRoot, 'platforms') : '';
if (platformsDir && fs.existsSync(platformsDir)) {
  const installedApis = fs
    .readdirSync(platformsDir)
    .map((name) => /^android-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  const highestApi = installedApis[installedApis.length - 1];
  const appGradlePath = path.join(androidRoot, 'app/build.gradle.kts');

  if (highestApi && fs.existsSync(appGradlePath)) {
    let gradle = fs.readFileSync(appGradlePath, 'utf8');
    const compileMatch = /compileSdk\s*=\s*(\d+)/.exec(gradle);
    const requestedApi = compileMatch ? Number(compileMatch[1]) : null;

    if (requestedApi && !installedApis.includes(requestedApi)) {
      gradle = gradle
        .replace(/compileSdk\s*=\s*\d+/g, `compileSdk = ${highestApi}`)
        .replace(/targetSdk\s*=\s*\d+/g, `targetSdk = ${highestApi}`);
      fs.writeFileSync(appGradlePath, gradle, 'utf8');
      console.log(
        `Menyelaraskan compileSdk/targetSdk dari ${requestedApi} ke SDK terpasang android-${highestApi}.`
      );
    }
  }
}

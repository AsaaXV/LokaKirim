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

if (!xml.includes('android:usesCleartextTraffic')) {
  xml = xml.replace(
    '<application',
    '<application\n        android:usesCleartextTraffic="true"'
  );
} else {
  xml = xml.replace(
    /android:usesCleartextTraffic="(?:false|true)"/,
    'android:usesCleartextTraffic="true"'
  );
}

fs.writeFileSync(manifestPath, xml, 'utf8');
console.log('AndroidManifest.xml berhasil dipatch untuk akses Wi-Fi LAN & izin perangkat.');

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

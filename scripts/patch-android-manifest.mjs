import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(
  process.cwd(),
  'src-tauri/gen/android/app/src/main/AndroidManifest.xml'
);

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

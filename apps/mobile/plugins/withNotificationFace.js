// Expo 57 exposes only a static large icon. Add a local persisted pixel avatar to its Android builder.
const { withDangerousMod, withAndroidManifest } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

function addFaceBuilder(source) {
  if (source.includes('// ftm-notification-face')) return source;
  const start = source.indexOf('  protected val largeIcon: Bitmap?');
  const getter = source.indexOf('    get() {', start);
  if (start < 0 || getter < 0) throw new Error('expo-notifications large icon getter changed');
  const offset = getter + '    get() {'.length;
  return source.slice(0, offset) + `
      // ftm-notification-face: data survives scheduled alarms and process death.
      val face = notificationContent.body?.optString("ftmFacePixels")
      if (!face.isNullOrEmpty()) {
        val pixels = face.split(",")
        if (pixels.size == 256 && pixels.all { it.matches(Regex("[0-9a-f]{8}")) }) {
          val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
          bitmap.setPixels(pixels.map { it.toLong(16).toInt() }.toIntArray(), 0, 16, 0, 0, 16, 16)
          return Bitmap.createScaledBitmap(bitmap, 128, 128, false)
        }
      }
` + source.slice(offset);
}

module.exports = config => {
  config = withAndroidManifest(config, mod => {
    const app = mod.modResults.manifest.application[0];
    app['meta-data'] = (app['meta-data'] || []).filter(item => item.$['android:name'] !== 'expo.modules.notifications.default_notification_icon');
    app['meta-data'].push({ $: { 'android:name': 'expo.modules.notifications.default_notification_icon', 'android:resource': '@drawable/ftm_notification_face' } });
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const expoDir = path.dirname(require.resolve('expo-notifications/package.json', { paths: [mod.modRequest.projectRoot] }));
    const builder = path.join(expoDir, 'android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt');
    fs.writeFileSync(builder, addFaceBuilder(fs.readFileSync(builder, 'utf8')));
    const drawable = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/drawable');
    fs.mkdirSync(drawable, { recursive: true });
    fs.writeFileSync(path.join(drawable, 'ftm_notification_face.xml'), '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="M6,3h12v3h3v12h-3v3H6v-3H3V6h3z M7,9v3h3V9z M14,9v3h3V9z M8,15v2h8v-2z"/></vector>');
    return mod;
  }]);
};
module.exports.addFaceBuilder = addFaceBuilder;

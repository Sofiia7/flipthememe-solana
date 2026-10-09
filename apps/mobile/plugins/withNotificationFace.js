// Expo 57 exposes only a static large icon. Add a local persisted pixel avatar to its Android builder.
const { withDangerousMod } = require('expo/config-plugins');
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
  return withDangerousMod(config, ['android', async mod => {
    const expoDir = path.dirname(require.resolve('expo-notifications/package.json', { paths: [mod.modRequest.projectRoot] }));
    const builder = path.join(expoDir, 'android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt');
    fs.writeFileSync(builder, addFaceBuilder(fs.readFileSync(builder, 'utf8')));
    return mod;
  }]);
};
module.exports.addFaceBuilder = addFaceBuilder;

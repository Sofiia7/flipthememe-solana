// Dynamic part of the Expo config (app.json stays the base): CI passes its run number as
// FTM_VERSION_CODE, so every APK has a higher Android versionCode than the one before it.
module.exports = ({ config }) => {
  const code = Number(process.env.FTM_VERSION_CODE);
  if (!Number.isInteger(code) || code <= 0) return config;
  return { ...config, android: { ...config.android, versionCode: code } };
};

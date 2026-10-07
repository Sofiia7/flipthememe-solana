import { useEffect, useRef } from 'react';
import { BackHandler, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MobileWalletProvider } from '@wallet-ui/react-native-kit';
import { APP_IDENTITY, CLUSTER } from './src/config';
import { loadPrefs } from './src/lib/prefs';
import { ArenaScreen } from './src/screens/ArenaScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { ShareCardHost } from './src/share/ShareCard';
import { preloadSounds } from './src/sound/sound';
import { AppProvider, useApp } from './src/state/AppProvider';
import { C } from './src/theme';
import { ResultLayer } from './src/ui/ResultLayer';
import { TabBar } from './src/ui/TabBar';

function Shell() {
  const insets = useSafeAreaInsets();
  const { tab, setTab, toasts, dismissToast } = useApp();

  useEffect(() => {
    loadPrefs();
    preloadSounds();
  }, []);

  // Back on Wallet, History or Profile goes to the Arena; on the Arena it leaves the app as before. The handler is
  // registered once and reads the latest state through refs, so it is never re-registered behind another one. A
  // result on screen has its own Back handler (it closes the result): this one steps aside for it. The sheets are
  // Modals and take Back themselves.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const resultShown = useRef(false);
  resultShown.current = toasts.length > 0;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (resultShown.current || tabRef.current === 'arena') return false;
      setTab('arena');
      return true;
    });
    return () => subscription.remove();
  }, [setTab]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>
        {tab === 'arena' ? <ArenaScreen /> : null}
        {tab === 'wallet' ? <WalletScreen /> : null}
        {tab === 'history' ? <HistoryScreen /> : null}
        {tab === 'profile' ? <ProfileScreen /> : null}
      </View>
      <TabBar tab={tab} onChange={setTab} bottomInset={insets.bottom} />
      {toasts[0] ? <ResultLayer toast={toasts[0]} onClose={dismissToast} top={insets.top + 8} /> : null}
      <ShareCardHost />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileWalletProvider cluster={CLUSTER} identity={APP_IDENTITY}>
        <AppProvider>
          <Shell />
        </AppProvider>
      </MobileWalletProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { flex: 1 },
});

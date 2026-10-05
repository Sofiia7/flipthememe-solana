import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MobileWalletProvider } from '@wallet-ui/react-native-kit';
import { APP_IDENTITY, CLUSTER } from './src/config';
import { ArenaScreen } from './src/screens/ArenaScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { AppProvider, useApp } from './src/state/AppProvider';
import { C } from './src/theme';
import { TabBar } from './src/ui/TabBar';
import { ResultToast } from './src/ui/Toast';

function Shell() {
  const insets = useSafeAreaInsets();
  const { tab, setTab, toasts, dismissToast } = useApp();
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>
        {tab === 'arena' ? <ArenaScreen /> : null}
        {tab === 'wallet' ? <WalletScreen /> : null}
        {tab === 'history' ? <HistoryScreen /> : null}
        {tab === 'profile' ? <ProfileScreen /> : null}
      </View>
      {toasts[0] ? <ResultToast toast={toasts[0]} onClose={dismissToast} top={insets.top + 8} /> : null}
      <TabBar tab={tab} onChange={setTab} bottomInset={insets.bottom} />
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

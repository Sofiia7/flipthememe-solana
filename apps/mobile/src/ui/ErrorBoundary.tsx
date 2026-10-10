import { Component, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { C } from '../theme';
import { Btn } from './common';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16, backgroundColor: C.bg }}><Text style={{ color: C.white }}>The screen could not be displayed. On-chain funds and saved pending transactions remain recoverable. Reload the screen; do not repeat a payment until its status is checked.</Text><Btn title="RELOAD SCREEN" onPress={() => this.setState({ failed: false })} /></View>;
  }
}

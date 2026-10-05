import { useMemo, useState } from "react";
import { Alert, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { createSolanaDevnet, MobileWalletProvider, useMobileWallet } from "@wallet-ui/react-native-kit";
import { PixelFace, type Face } from "./src/PixelFace";

const cluster = createSolanaDevnet({ url: "https://api.devnet.solana.com" });
const identity = { name: "FlipTheMeme", uri: "https://flipthememe.app", icon: "icon.png" };
const amounts = ["0.01", "0.03", "0.10", "0.30"];
const me: Face = { skin: "#cc8c62", hair: "bangs", hairColor: "#231829", eye: "#241c28", accessory: "none" };
const players = [
  { name: "sofi.skr", amount: "0.60", face: { skin: "#d799e8", hair: "side", hairColor: "#5b2d8f", eye: "#1f1a2a", accessory: "none" as const } },
  { name: "ren.skr", amount: "0.80", face: { skin: "#7b4c36", hair: "bangs", hairColor: "#1d1520", eye: "#18131c", accessory: "glasses" as const } },
  { name: "lumen.skr", amount: "0.50", face: { skin: "#e6a75d", hair: "side", hairColor: "#ecb54a", eye: "#251b20", accessory: "none" as const } },
];

function Arena() {
  const { account, connect, disconnect } = useMobileWallet();
  const [side, setSide] = useState<"UP" | "DOWN">("UP");
  const [amount, setAmount] = useState("0.03");
  const preview = useMemo(() => (side === "UP" ? "~0.050 SOL" : "~0.029 SOL"), [side]);
  const shortAddress = account ? `${account.address.slice(0, 4)}…${account.address.slice(-4)}` : null;

  async function onWallet() {
    try { if (account) await disconnect(); else await connect(); }
    catch { Alert.alert("Кошелёк не подключился", "Открой приложение через development build и проверь MWA-кошелёк."); }
  }
  async function enter() {
    if (!account) { await onWallet(); return; }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert("Денежный вход отключён", "Источник цены и программа ещё проходят проверку. Подключение кошелька не создаёт ставку и не блокирует SOL.");
  }
  return <SafeAreaView style={styles.safe}>
    <StatusBar barStyle="light-content" />
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}><View><Text style={styles.wordmark}>$FLIPTHEMEME</Text><Text style={styles.subtle}>devnet • общий раунд</Text></View><Pressable onPress={onWallet} style={styles.wallet}><Text style={styles.walletText}>{shortAddress ?? "ПОДКЛЮЧИТЬ"}</Text></Pressable></View>
      <View style={styles.tokenRow}><View><Text style={styles.token}>$TIKTOK</Text><Text style={styles.subtle}>6 мин • mock source • пул проверяется</Text></View><View style={styles.live}><Text style={styles.liveText}>OPEN</Text></View></View>
      <View style={styles.chart}><View style={styles.grid} /> <View style={styles.lineOne}/><View style={styles.lineTwo}/><Text style={styles.chartLabel}>+5.5%</Text><Text style={styles.startLine}>P0</Text></View>
      <View style={styles.timerBox}><Text style={styles.timerCaption}>ВХОД ЗАКРОЕТСЯ ЧЕРЕЗ</Text><Text style={styles.timer}>00:15</Text><Text style={styles.subtle}>Движение измерим 60 секунд после закрытия</Text></View>
      <View style={styles.pools}><Pool title="UP" amount="2.3 SOL" active={side === "UP"} players={players.slice(0, 2)} onPress={() => setSide("UP")} /><Pool title="DOWN" amount="1.8 SOL" active={side === "DOWN"} players={players.slice(2)} onPress={() => setSide("DOWN")} /></View>
      <View style={styles.position}><View><Text style={styles.positionLabel}>ТВОЙ ПРОГНОЗ</Text><Text style={styles.positionValue}>{side} • {amount} SOL не отправлены</Text></View><PixelFace face={me} size={42}/></View>
      <Text style={styles.sectionTitle}>ПРЕДПРОСМОТР DEVNET</Text><View style={styles.amounts}>{amounts.map((value) => <Pressable key={value} onPress={() => setAmount(value)} style={[styles.amount, amount === value && styles.amountActive]}><Text style={styles.amountText}>{value} SOL</Text></Pressable>)}</View>
      <View style={styles.disclosure}><Text style={styles.subtle}>Предварительная выплата: {preview}. Это mock-расчёт: ставка не создаётся и SOL не блокируются.</Text></View>
      <Pressable onPress={enter} style={styles.enter}><Text style={styles.enterText}>{account ? "ДЕНЕЖНЫЙ РЕЖИМ ОТКЛЮЧЁН" : "ПОДКЛЮЧИТЬ КОШЕЛЁК"}</Text></Pressable>
      <Text style={styles.footer}>Без покупки токена • mock-данные • реальных позиций и выплат пока нет</Text>
    </ScrollView>
  </SafeAreaView>;
}

function Pool({ title, amount, active, players: list, onPress }: { title: string; amount: string; active: boolean; players: typeof players; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.pool, active && styles.poolActive]}><View style={styles.poolHeading}><Text style={[styles.poolTitle, title === "UP" ? styles.up : styles.down]}>{title}</Text><Text style={styles.poolAmount}>{amount}</Text></View>{list.map((player) => <View key={player.name} style={styles.player}><PixelFace face={player.face} size={26}/><Text style={styles.playerName}>{player.name}</Text><Text style={styles.playerAmount}>{player.amount}</Text></View>)}<Text style={styles.more}>+ {title === "UP" ? "12" : "8"} игроков</Text></Pressable>;
}

export default function App() { return <MobileWalletProvider cluster={cluster} identity={identity}><Arena /></MobileWalletProvider>; }

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:"#100d1f"},page:{padding:16,gap:12,backgroundColor:"#100d1f"},header:{flexDirection:"row",justifyContent:"space-between",alignItems:"center"},wordmark:{color:"#fff",fontFamily:"monospace",fontWeight:"900",fontSize:16},subtle:{color:"#9f9aad",fontSize:11,lineHeight:16},wallet:{borderWidth:1,borderColor:"#a459ff",paddingHorizontal:10,paddingVertical:7},walletText:{color:"#e0c1ff",fontSize:11,fontWeight:"800"},tokenRow:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginTop:8},token:{fontSize:28,fontWeight:"900",color:"#fff"},live:{backgroundColor:"#35df6c",paddingHorizontal:8,paddingVertical:3},liveText:{fontSize:10,fontWeight:"900",color:"#111b13"},chart:{height:190,backgroundColor:"#2b2d36",overflow:"hidden",borderWidth:1,borderColor:"#484b58",position:"relative"},grid:{...StyleSheet.absoluteFill,opacity:.32,backgroundColor:"#5b6070"},lineOne:{position:"absolute",height:3,width:"82%",backgroundColor:"#35df6c",transform:[{rotate:"-16deg"}],left:10,top:86},lineTwo:{position:"absolute",height:3,width:"42%",backgroundColor:"#f1be3e",transform:[{rotate:"15deg"}],left:"52%",top:73},chartLabel:{position:"absolute",right:12,top:13,color:"#35df6c",fontWeight:"900",fontFamily:"monospace"},startLine:{position:"absolute",left:10,bottom:12,color:"#c9c4d5",fontWeight:"800",fontSize:11},timerBox:{alignItems:"center",gap:3},timerCaption:{color:"#f4bf3d",fontWeight:"800",fontSize:10},timer:{borderWidth:2,borderColor:"#f4bf3d",paddingHorizontal:8,paddingVertical:1,color:"#fff",fontSize:26,fontFamily:"monospace",fontWeight:"900"},pools:{flexDirection:"row",gap:10},pool:{flex:1,borderWidth:1,borderColor:"#454055",backgroundColor:"#1c1830",padding:9,gap:7},poolActive:{borderColor:"#a459ff",borderWidth:2},poolHeading:{flexDirection:"row",justifyContent:"space-between"},poolTitle:{fontSize:16,fontWeight:"900"},up:{color:"#35df6c"},down:{color:"#fb607c"},poolAmount:{color:"#fff",fontFamily:"monospace",fontWeight:"800",fontSize:12},player:{flexDirection:"row",alignItems:"center",gap:5},playerName:{color:"#e6e0f1",fontSize:10,flex:1},playerAmount:{color:"#35df6c",fontFamily:"monospace",fontSize:10},more:{color:"#9f9aad",fontSize:10},position:{borderWidth:1,borderColor:"#7650a6",backgroundColor:"#20183a",padding:10,flexDirection:"row",justifyContent:"space-between",alignItems:"center"},positionLabel:{color:"#a89aba",fontSize:10,fontWeight:"800"},positionValue:{color:"#fff",fontSize:13,fontWeight:"800",marginTop:3},sectionTitle:{color:"#a89aba",fontSize:10,fontWeight:"900",marginTop:4},amounts:{flexDirection:"row",gap:7},amount:{flex:1,borderWidth:1,borderColor:"#48405c",paddingVertical:11,alignItems:"center"},amountActive:{backgroundColor:"#9c54ff",borderColor:"#b982ff"},amountText:{color:"#fff",fontSize:10,fontWeight:"800"},disclosure:{backgroundColor:"#19152a",padding:8},enter:{backgroundColor:"#35df6c",alignItems:"center",padding:15,borderWidth:2,borderColor:"#84ff9d"},enterText:{fontSize:14,fontWeight:"900",color:"#102315"},footer:{color:"#736d82",fontSize:10,textAlign:"center",paddingBottom:16}
});

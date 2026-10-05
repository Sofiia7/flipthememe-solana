import { StyleSheet, View } from "react-native";

export type Face = {
  skin: string;
  hair: string;
  hairColor: string;
  eye: string;
  accessory?: "none" | "glasses" | "cap";
};

/** A compact 32px pixel head: no torso, shoulders, or full-body character. */
export function PixelFace({ face, size = 32 }: { face: Face; size?: number }) {
  const unit = size / 8;
  return (
    <View style={[styles.canvas, { width: size, height: size, borderRadius: unit / 2 }]}>
      <View style={[styles.hairBack, { backgroundColor: face.hairColor, left: unit, top: 0, width: unit * 6, height: unit * 5 }]} />
      <View style={[styles.head, { backgroundColor: face.skin, left: unit, top: unit * 2, width: unit * 6, height: unit * 5 }]} />
      <View style={[styles.fringe, { backgroundColor: face.hairColor, left: face.hair === "side" ? unit : unit * 2, top: unit, width: face.hair === "bangs" ? unit * 5 : unit * 3, height: unit * 2 }]} />
      <View style={[styles.eye, { backgroundColor: face.eye, left: unit * 2, top: unit * 4, width: unit, height: unit }]} />
      <View style={[styles.eye, { backgroundColor: face.eye, left: unit * 5, top: unit * 4, width: unit, height: unit }]} />
      <View style={[styles.mouth, { left: unit * 3, top: unit * 6, width: unit * 2, height: Math.max(1, unit / 2) }]} />
      {face.accessory === "glasses" ? <View style={[styles.glasses, { left: unit * 1.5, top: unit * 3.6, width: unit * 5, height: unit * 1.6 }]} /> : null}
      {face.accessory === "cap" ? <View style={[styles.cap, { backgroundColor: "#9c54ff", left: unit, top: 0, width: unit * 6, height: unit * 1.5 }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { overflow: "hidden", backgroundColor: "#29233c" },
  hairBack: { position: "absolute" }, head: { position: "absolute" }, fringe: { position: "absolute" },
  eye: { position: "absolute" }, mouth: { position: "absolute", backgroundColor: "#743b54" },
  glasses: { position: "absolute", borderColor: "#a8d7ff", borderWidth: 1 }, cap: { position: "absolute" },
});

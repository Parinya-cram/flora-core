import type { CSSProperties } from "react";
import ioIconSetUrl from "../../assets/io/ioiconset.png";
import lightIoIconSetUrl from "../../assets/io/ioiconset-light.png";
import inputIconSetUrl from "../../assets/io/inputset.png";
import lightInputIconSetUrl from "../../assets/io/inputset-light.png";
import bloodLossIconUrl from "../../assets/io/bloodloss.png";
import lightBloodLossIconUrl from "../../assets/io/bloodloss-light.png";
import urineIconUrl from "../../assets/io/urine.png";
import lightUrineIconUrl from "../../assets/io/urine-light.png";

export type IoIconName =
  | "input"
  | "output"
  | "balance"
  | "activeDrips"
  | "medBolus"
  | "medDrip"
  | "fluid"
  | "bloodProduct"
  | "bloodLoss"
  | "urine";

const IO_ICON_CROPS: Record<IoIconName, { x: number; y: number }> = {
  input: { x: 111, y: 146 },
  output: { x: 456, y: 146 },
  balance: { x: 801, y: 146 },
  activeDrips: { x: 1159, y: 146 },
  medBolus: { x: 111, y: 532 },
  medDrip: { x: 456, y: 532 },
  fluid: { x: 801, y: 532 },
  bloodProduct: { x: 1159, y: 532 },
  bloodLoss: { x: 0, y: 0 },
  urine: { x: 0, y: 0 },
};

const INPUT_ICON_CROPS: Partial<Record<IoIconName, { x: number; y: number }>> = {
  medBolus: { x: 107, y: 124 },
  medDrip: { x: 636, y: 124 },
  fluid: { x: 1157, y: 124 },
  bloodProduct: { x: 1688, y: 124 },
};

export default function IoSpriteIcon({
  name,
  size = 40,
  className = "",
}: {
  name: IoIconName;
  size?: number;
  className?: string;
}) {
  const standaloneCrop =
    name === "bloodLoss"
      ? { x: 210, y: 70, size: 900, width: 1325, height: 1187, url: bloodLossIconUrl }
      : name === "urine"
        ? { x: 160, y: 115, size: 930, width: 1254, height: 1254, url: urineIconUrl }
        : null;
  const inputCrop = INPUT_ICON_CROPS[name];
  const cropSize = standaloneCrop?.size ?? (inputCrop ? 380 : 260);
  const scale = size / cropSize;
  const crop = standaloneCrop || inputCrop || IO_ICON_CROPS[name];
  const spriteWidth = standaloneCrop?.width ?? (inputCrop ? 2172 : 1536);
  const spriteHeight = standaloneCrop?.height ?? (inputCrop ? 724 : 1024);
  const darkImageUrl = standaloneCrop?.url ?? (inputCrop ? inputIconSetUrl : ioIconSetUrl);
  const lightImageUrl =
    name === "bloodLoss"
      ? lightBloodLossIconUrl
      : name === "urine"
        ? lightUrineIconUrl
        : inputCrop
          ? lightInputIconSetUrl
          : lightIoIconSetUrl;
  const spriteStyle = {
    width: size,
    height: size,
    "--io-icon-dark-image": `url(${darkImageUrl})`,
    "--io-icon-light-image": `url(${lightImageUrl})`,
    backgroundImage: "var(--io-icon-image, var(--io-icon-dark-image))",
    backgroundRepeat: "no-repeat",
    backgroundSize: `${spriteWidth * scale}px ${spriteHeight * scale}px`,
    backgroundPosition: `${-crop.x * scale}px ${-crop.y * scale}px`,
    imageRendering: "pixelated",
  } as CSSProperties;

  return (
    <span
      className={`io-sprite-icon inline-block shrink-0 ${className}`}
      aria-hidden="true"
      style={spriteStyle}
    />
  );
}

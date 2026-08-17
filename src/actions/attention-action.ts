import { action, type KeyAction, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import type { FaceDescriptor } from "../face/descriptor.js";
import { renderFaceSvg, svgToImageUri } from "../face/render.js";

/**
 * The one static face the skeleton paints. Hard-coded on purpose: this ticket
 * proves the render path from a descriptor to pixels on the key, before any
 * policy exists to derive a descriptor from a herdr snapshot.
 */
const STATIC_FACE: FaceDescriptor = {
  stateColour: "red",
  nameplate: "herdr",
  body: "trunk",
};

/**
 * The attention button. One tile per herdr session — for now, one tile that
 * draws {@link STATIC_FACE} whenever it appears.
 */
@action({ UUID: "dev.yrh.sd-herdr.attention" })
export class AttentionAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent): Promise<void> | void {
    if (!ev.action.isKey()) return;
    return paint(ev.action, STATIC_FACE);
  }
}

/** Draw a face onto a key. The only place the SDK and the renderer meet. */
function paint(key: KeyAction, face: FaceDescriptor): Promise<void> {
  return key.setImage(svgToImageUri(renderFaceSvg(face)));
}

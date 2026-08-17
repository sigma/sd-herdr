import streamDeck from "@elgato/streamdeck";

import { AttentionAction } from "./actions/attention-action.js";

streamDeck.actions.registerAction(new AttentionAction());

streamDeck.connect();

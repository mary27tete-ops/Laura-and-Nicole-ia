// FIX: Removed 'GenerativeModel' which is not an exported member and added 'Modality' for use in configs.
import { GoogleGenAI, Chat, Tool, Type, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

// FIX: Updated model name 'gemini-2.5-flash-lite' to 'gemini-flash-lite-latest' as per guidelines.
type ChatModel = 'gemini-flash-lite-latest' | 'gemini-2.5-flash' | 'gemini-2.5-pro';

export const createChatSession = (model: ChatModel, systemInstruction: string): Chat => {
  const config: {
    systemInstruction: string;
    tools?: Tool[];
    thinkingConfig?: { thinkingBudget: number };
  } = {
    systemInstruction: systemInstruction,
  };

  if (model === 'gemini-2.5-pro') {
    config.thinkingConfig = { thinkingBudget: 32768 };
  }
  
  if (model === 'gemini-2.5-flash') {
    config.tools = [{ googleSearch: {} }, { googleMaps: {} }];
  }

  const chat: Chat = ai.chats.create({
    model: model,
    config: config,
  });

  return chat;
};

export const editImage = async (
  prompt: string,
  imageData: { data: string; mimeType: string }
): Promise<string | null> => {
  try {
    const model = 'gemini-2.5-flash-image';
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [
          { inlineData: { data: imageData.data, mimeType: imageData.mimeType } },
          { text: prompt },
        ],
      },
      config: {
        // FIX: Replaced string literal 'IMAGE' with Modality.IMAGE enum for correctness.
        responseModalities: [Modality.IMAGE],
      },
    });
    
    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part && part.inlineData && part.inlineData.data) {
      return part.inlineData.data;
    }
    return null;
  } catch (error) {
    console.error("Error editing image:", error);
    return null;
  }
};

export const generateSpeech = async (
  text: string,
  voice: 'Kore' | 'Charon' = 'Kore'
): Promise<string | null> => {
  try {
    const model = "gemini-2.5-flash-preview-tts";
    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        // FIX: Replaced string literal 'AUDIO' with Modality.AUDIO enum for correctness.
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part && part.inlineData && part.inlineData.data) {
      return part.inlineData.data;
    }
    return null;
  } catch (error) {
    console.error("Error generating speech:", error);
    return null;
  }
};

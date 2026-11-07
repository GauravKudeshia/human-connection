// Written samples, not generated host responses or therapeutic exercises.
export const activities = [
  {
    id: "laugh-story",
    experience: "laugh",
    style: "funny-stories",
    title: "The tiny plot twist",
    prompt:
      "Choose a setting for a funny story: a delayed train, a family dinner, or a very important meeting.",
    note: "In a real session, invite your host to tell a story. There is no host response in this demo.",
  },
  {
    id: "laugh-banter",
    experience: "laugh",
    style: "playful-banter",
    title: "Would you rather…",
    prompt:
      "Would you rather have entrance music every time you walk into a room or a dramatic narrator for every grocery trip?",
    note: "Pick a side, then make the most ridiculous case for it.",
  },
  {
    id: "laugh-improv",
    experience: "laugh",
    style: "improv-games",
    title: "A wildly unhelpful invention",
    prompt:
      "Pitch an umbrella for houseplants. Give it a name, a slogan, and one completely unnecessary feature.",
    note: "You and a real host could take turns adding one detail. Participation is always optional.",
  },
  {
    id: "hear-day",
    experience: "hear",
    style: "my-day",
    title: "Where should we start?",
    prompt:
      "Was there a small moment from today you would like someone to hear about?",
    note: "Share as much or as little as you want. Friendly conversation, not counseling.",
  },
  {
    id: "hear-listen",
    experience: "hear",
    style: "just-listen",
    title: "Set the pace",
    prompt: "Would you like room to speak, a few questions, or a bit of both?",
    note: "This is a preference you could share with your host. No need to explain or solve anything.",
  },
  {
    id: "hear-chat",
    experience: "hear",
    style: "friendly-conversation",
    title: "A small good thing",
    prompt:
      "What is something ordinary you have been enjoying lately—a meal, a song, a place?",
    note: "Skip this card if you would rather talk about something else.",
  },
  {
    id: "distract-trivia",
    experience: "distract",
    style: "trivia-questions",
    title: "A little trivia detour",
    prompt: "Which has more sides: a hexagon or an octagon?",
    answer: "An octagon has eight sides; a hexagon has six.",
    note: "Try an answer, then reveal it. No scores or competition required.",
  },
  {
    id: "distract-stories",
    experience: "distract",
    style: "unexpected-stories",
    title: "The door marked “Maybe”",
    prompt: "A tiny door appears in your favorite café. What is behind it?",
    note: "With a real host, you could each add a sentence. The demo does not invent a participant.",
  },
  {
    id: "distract-games",
    experience: "distract",
    style: "conversation-games",
    title: "Three clues, one place",
    prompt:
      "Think of a place. Describe it using three clues without naming it.",
    note: "Your real host could guess, then swap roles. For now, explore the sample controls.",
  },
];
export const activitiesFor = (experience) =>
  activities.filter((a) => a.experience === experience);
export const suggestedActivity = (booking) =>
  activities.find(
    (a) => a.experience === booking.experience && a.style === booking.style,
  ) || activitiesFor(booking.experience)[0];

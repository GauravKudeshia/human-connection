export const experiences = [
  {
    id: "laugh",
    name: "Make Me Laugh",
    note: "A little less serious. A lot more smiling.",
    tag: "FOR A LIGHTER DAY",
    color: "peach",
    topics: ["Funny stories", "Playful banter", "Good energy"],
  },
  {
    id: "hear",
    name: "Hear Me Out",
    note: "Space to talk. Someone who really listens.",
    tag: "FOR WHAT’S ON YOUR MIND",
    color: "blue",
    topics: ["A listening ear", "Life lately", "Real conversation"],
  },
  {
    id: "distract",
    name: "Distract Me",
    note: "Get out of your head and into something fun.",
    tag: "FOR A FRESH PERSPECTIVE",
    color: "green",
    topics: ["Trivia & games", "Curious questions", "Shared interests"],
  },
];
export const hosts = [
  {
    id: "maya",
    styles: ["my-day", "just-listen", "unexpected-stories"],
    conversationStyle: "Thoughtful, unhurried conversation",
    interests: ["Books", "Baking", "Everyday stories"],
    name: "Maya",
    pronouns: "she/her",
    headline: "Your story deserves a good listener.",
    bio: "I’m a book lover, a weekend baker, and the friend who always has time for one more story. Bring your big thoughts, little wins, or a day that just needs talking through.",
    experiences: ["hear", "distract"],
    languages: ["English", "Spanish"],
    formats: ["video", "audio"],
    tags: ["Thoughtful", "Easygoing", "Books & life"],
    color: "blue",
    reviews: 0,
  },
  {
    id: "james",
    styles: ["funny-stories", "improv-games", "unexpected-stories"],
    conversationStyle: "Warm storytelling with a playful twist",
    interests: ["Comedy", "Pop culture", "Food"],
    name: "James",
    pronouns: "he/him",
    headline: "Good stories. Questionable dad jokes.",
    bio: "A curious human with a soft spot for silly stories, spontaneous impressions, and the kind of laugh that catches you off guard. Let’s find the funny in the everyday.",
    experiences: ["laugh", "distract"],
    languages: ["English"],
    formats: ["video", "audio"],
    tags: ["Quick-witted", "Warm", "Pop culture"],
    color: "peach",
    reviews: 0,
  },
  {
    id: "sofia",
    styles: ["trivia-questions", "unexpected-stories", "friendly-conversation"],
    conversationStyle: "Curious questions and unexpected detours",
    interests: ["Travel", "Food", "Odd facts"],
    name: "Sofia",
    pronouns: "she/her",
    headline: "Let’s follow our curiosity somewhere.",
    bio: "Ask me about travel, food, or an oddly specific fun fact. I love making a little room in the day for an unexpected conversation and a different point of view.",
    experiences: ["distract", "hear"],
    languages: ["English", "Spanish"],
    formats: ["video", "audio"],
    tags: ["Curious", "Creative", "Travel"],
    color: "green",
    reviews: 0,
  },
  {
    id: "daniel",
    styles: ["playful-banter", "improv-games", "conversation-games"],
    conversationStyle: "Easygoing banter and quick games",
    interests: ["Music", "Movies", "Word games"],
    name: "Daniel",
    pronouns: "he/him",
    headline: "A little banter goes a long way.",
    bio: "Music, movie debates, and an endless supply of would-you-rather questions. I bring a relaxed pace and a sense of humor to every conversation.",
    experiences: ["laugh", "distract"],
    languages: ["English"],
    formats: ["audio"],
    tags: ["Playful", "Music lover", "Movies"],
    color: "peach",
    reviews: 0,
  },
  {
    id: "aisha",
    styles: ["my-day", "just-listen", "friendly-conversation"],
    conversationStyle: "Space to talk at your own pace",
    interests: ["Walking", "Cooking", "Everyday life"],
    name: "Aisha",
    pronouns: "she/her",
    headline: "Come as you are. I’m all ears.",
    bio: "Sometimes you just want to say it out loud. I’m here for your everyday stories, your next chapter, and the small things that matter to you.",
    experiences: ["hear"],
    languages: ["English"],
    formats: ["video", "audio"],
    tags: ["Grounded", "Kind", "Everyday life"],
    color: "blue",
    reviews: 0,
  },
];
export const money = (cents) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

export const conversationStyles = {
  laugh: [
    {
      id: "funny-stories",
      name: "Funny Stories",
      note: "Everyday life, with a plot twist.",
    },
    {
      id: "playful-banter",
      name: "Playful Banter",
      note: "A little back-and-forth. A lot of personality.",
    },
    {
      id: "improv-games",
      name: "Improv & Games",
      note: "Make something silly together.",
    },
  ],
  hear: [
    {
      id: "my-day",
      name: "Talk About My Day",
      note: "The big things, the little things, all of it.",
    },
    {
      id: "just-listen",
      name: "Just Listen",
      note: "You set the pace. Your host makes room.",
    },
    {
      id: "friendly-conversation",
      name: "Friendly Conversation",
      note: "An easy chat, wherever it goes.",
    },
  ],
  distract: [
    {
      id: "trivia-questions",
      name: "Trivia & Questions",
      note: "A curious little detour.",
    },
    {
      id: "unexpected-stories",
      name: "Unexpected Stories",
      note: "Follow a story somewhere new.",
    },
    {
      id: "conversation-games",
      name: "Conversation Games",
      note: "Play with ideas, one turn at a time.",
    },
  ],
};
export const stylesFor = (experience) => conversationStyles[experience] || [];
export const styleName = (id) =>
  Object.values(conversationStyles)
    .flat()
    .find((s) => s.id === id)?.name || "Let it flow";

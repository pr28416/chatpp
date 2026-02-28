export interface Moment {
  id: string
  message: string
  timestamp: Date
  sender: string
  sentiment: "positive" | "neutral" | "negative"
}

export interface Subtopic {
  id: string
  title: string
  summary: string
  timeRange: string
  moments: Moment[]
}

export interface Topic {
  id: string
  title: string
  description: string
  startDate: Date
  endDate: Date
  color: string
  subtopics: Subtopic[]
}

// Helper to create dates
const createDate = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month - 1, day, hour, minute)

export const timelineData: Topic[] = [
  {
    id: "1",
    title: "Trip Planning",
    description: "Discussing the upcoming weekend getaway to Big Sur. Comparing accommodations, planning activities, and coordinating the driving route.",
    startDate: createDate(2, 24, 14, 30),
    endDate: createDate(2, 24, 16, 45),
    color: "#3b82f6",
    subtopics: [
      {
        id: "1-1",
        title: "Accommodation Options",
        summary: "Comparing Airbnb vs hotels near the coast",
        timeRange: "2:30 PM - 3:15 PM",
        moments: [
          { id: "1-1-1", message: "Found this amazing cabin with ocean views!", timestamp: createDate(2, 24, 14, 30), sender: "Alex", sentiment: "positive" },
          { id: "1-1-2", message: "How much per night?", timestamp: createDate(2, 24, 14, 31), sender: "You", sentiment: "neutral" },
          { id: "1-1-3", message: "$180 but it's got a hot tub", timestamp: createDate(2, 24, 14, 32), sender: "Alex", sentiment: "positive" },
          { id: "1-1-4", message: "That's actually reasonable for Big Sur", timestamp: createDate(2, 24, 14, 35), sender: "You", sentiment: "positive" },
          { id: "1-1-5", message: "Right? The hotel was $250 and no hot tub", timestamp: createDate(2, 24, 14, 36), sender: "Alex", sentiment: "neutral" },
          { id: "1-1-6", message: "Let me check the reviews real quick", timestamp: createDate(2, 24, 14, 38), sender: "You", sentiment: "neutral" },
          { id: "1-1-7", message: "4.9 stars with 200+ reviews", timestamp: createDate(2, 24, 14, 42), sender: "Alex", sentiment: "positive" },
          { id: "1-1-8", message: "Book it!", timestamp: createDate(2, 24, 14, 43), sender: "You", sentiment: "positive" },
        ]
      },
      {
        id: "1-2",
        title: "Activity Ideas",
        summary: "Hiking trails and restaurant recommendations",
        timeRange: "3:20 PM - 4:00 PM",
        moments: [
          { id: "1-2-1", message: "We should definitely do the Pfeiffer Falls trail", timestamp: createDate(2, 24, 15, 20), sender: "You", sentiment: "positive" },
          { id: "1-2-2", message: "Is that the one with the waterfall?", timestamp: createDate(2, 24, 15, 21), sender: "Alex", sentiment: "neutral" },
          { id: "1-2-3", message: "Yes! 1.5 miles roundtrip, super easy", timestamp: createDate(2, 24, 15, 22), sender: "You", sentiment: "positive" },
          { id: "1-2-4", message: "Perfect for morning before it gets crowded", timestamp: createDate(2, 24, 15, 25), sender: "Alex", sentiment: "positive" },
          { id: "1-2-5", message: "And Nepenthe for lunch after?", timestamp: createDate(2, 24, 15, 28), sender: "You", sentiment: "neutral" },
          { id: "1-2-6", message: "Omg yes their views are insane", timestamp: createDate(2, 24, 15, 29), sender: "Alex", sentiment: "positive" },
        ]
      },
      {
        id: "1-3",
        title: "Logistics",
        summary: "Driving route and packing list",
        timeRange: "4:15 PM - 4:45 PM",
        moments: [
          { id: "1-3-1", message: "Should we take Highway 1 the whole way?", timestamp: createDate(2, 24, 16, 15), sender: "Alex", sentiment: "neutral" },
          { id: "1-3-2", message: "It's longer but way more scenic", timestamp: createDate(2, 24, 16, 16), sender: "You", sentiment: "neutral" },
          { id: "1-3-3", message: "Let's do it, we're not in a rush", timestamp: createDate(2, 24, 16, 18), sender: "Alex", sentiment: "positive" },
          { id: "1-3-4", message: "I'll bring the camera and tripod", timestamp: createDate(2, 24, 16, 22), sender: "You", sentiment: "positive" },
          { id: "1-3-5", message: "Golden hour at Bixby Bridge is going to be incredible", timestamp: createDate(2, 24, 16, 24), sender: "Alex", sentiment: "positive" },
        ]
      }
    ]
  },
  {
    id: "2",
    title: "Work Project",
    description: "Brainstorming the new product launch strategy. Evaluating marketing channels and finalizing the Q2 budget allocation.",
    startDate: createDate(2, 23, 10, 0),
    endDate: createDate(2, 23, 14, 45),
    color: "#10b981",
    subtopics: [
      {
        id: "2-1",
        title: "Marketing Channels",
        summary: "Evaluating social media vs traditional advertising",
        timeRange: "10:00 AM - 11:30 AM",
        moments: [
          { id: "2-1-1", message: "I think we should focus on Instagram and TikTok", timestamp: createDate(2, 23, 10, 0), sender: "You", sentiment: "neutral" },
          { id: "2-1-2", message: "Our demo skews younger so that makes sense", timestamp: createDate(2, 23, 10, 2), sender: "Jordan", sentiment: "positive" },
          { id: "2-1-3", message: "What about LinkedIn for the B2B angle?", timestamp: createDate(2, 23, 10, 5), sender: "Jordan", sentiment: "neutral" },
          { id: "2-1-4", message: "Good point, we can repurpose content there", timestamp: createDate(2, 23, 10, 8), sender: "You", sentiment: "positive" },
          { id: "2-1-5", message: "I can handle the LinkedIn strategy", timestamp: createDate(2, 23, 10, 12), sender: "Jordan", sentiment: "positive" },
          { id: "2-1-6", message: "Perfect, I'll focus on short-form video", timestamp: createDate(2, 23, 10, 15), sender: "You", sentiment: "positive" },
        ]
      },
      {
        id: "2-2",
        title: "Budget Allocation",
        summary: "Breaking down the Q2 marketing spend",
        timeRange: "2:00 PM - 2:45 PM",
        moments: [
          { id: "2-2-1", message: "We have $50k for the quarter", timestamp: createDate(2, 23, 14, 0), sender: "Jordan", sentiment: "neutral" },
          { id: "2-2-2", message: "I'd put 60% into paid social", timestamp: createDate(2, 23, 14, 2), sender: "You", sentiment: "neutral" },
          { id: "2-2-3", message: "And the rest for influencer partnerships?", timestamp: createDate(2, 23, 14, 5), sender: "Jordan", sentiment: "neutral" },
          { id: "2-2-4", message: "Exactly. I have a few micro-influencers in mind", timestamp: createDate(2, 23, 14, 8), sender: "You", sentiment: "positive" },
          { id: "2-2-5", message: "Send me the list, I'll start outreach", timestamp: createDate(2, 23, 14, 10), sender: "Jordan", sentiment: "positive" },
        ]
      }
    ]
  },
  {
    id: "3",
    title: "Birthday Planning",
    description: "Surprise party coordination for Sarah's 30th. Booking the venue, managing the guest list, and keeping it all secret.",
    startDate: createDate(2, 22, 18, 0),
    endDate: createDate(2, 22, 20, 30),
    color: "#f59e0b",
    subtopics: [
      {
        id: "3-1",
        title: "Venue Selection",
        summary: "Deciding between rooftop bar and restaurant",
        timeRange: "6:00 PM - 6:30 PM",
        moments: [
          { id: "3-1-1", message: "The rooftop at The Standard is available!", timestamp: createDate(2, 22, 18, 0), sender: "Taylor", sentiment: "positive" },
          { id: "3-1-2", message: "That's perfect, she loves that place", timestamp: createDate(2, 22, 18, 2), sender: "You", sentiment: "positive" },
          { id: "3-1-3", message: "They need a $500 minimum spend though", timestamp: createDate(2, 22, 18, 5), sender: "Taylor", sentiment: "negative" },
          { id: "3-1-4", message: "With 15 people that's easy", timestamp: createDate(2, 22, 18, 6), sender: "You", sentiment: "positive" },
          { id: "3-1-5", message: "True, drinks alone will cover it", timestamp: createDate(2, 22, 18, 8), sender: "Taylor", sentiment: "positive" },
        ]
      },
      {
        id: "3-2",
        title: "Guest List",
        summary: "Finalizing invites and RSVPs",
        timeRange: "6:35 PM - 7:00 PM",
        moments: [
          { id: "3-2-1", message: "I've got 12 confirmed so far", timestamp: createDate(2, 22, 18, 35), sender: "You", sentiment: "positive" },
          { id: "3-2-2", message: "Did you invite Mike and Lisa?", timestamp: createDate(2, 22, 18, 36), sender: "Taylor", sentiment: "neutral" },
          { id: "3-2-3", message: "Yes they're both coming", timestamp: createDate(2, 22, 18, 38), sender: "You", sentiment: "positive" },
          { id: "3-2-4", message: "What about her work friends?", timestamp: createDate(2, 22, 18, 40), sender: "Taylor", sentiment: "neutral" },
          { id: "3-2-5", message: "I reached out to Emma, she's handling that group", timestamp: createDate(2, 22, 18, 42), sender: "You", sentiment: "positive" },
        ]
      },
      {
        id: "3-3",
        title: "Cake & Decorations",
        summary: "Ordering the cake and party supplies",
        timeRange: "7:15 PM - 7:45 PM",
        moments: [
          { id: "3-3-1", message: "She mentioned wanting lemon cake recently", timestamp: createDate(2, 22, 19, 15), sender: "Taylor", sentiment: "neutral" },
          { id: "3-3-2", message: "Noted! I'll order from that bakery downtown", timestamp: createDate(2, 22, 19, 17), sender: "You", sentiment: "positive" },
          { id: "3-3-3", message: "The one with the amazing frosting?", timestamp: createDate(2, 22, 19, 18), sender: "Taylor", sentiment: "positive" },
          { id: "3-3-4", message: "Exactly that one", timestamp: createDate(2, 22, 19, 19), sender: "You", sentiment: "positive" },
        ]
      },
      {
        id: "3-4",
        title: "Surprise Coordination",
        summary: "Planning how to get her there without suspicion",
        timeRange: "8:00 PM - 8:30 PM",
        moments: [
          { id: "3-4-1", message: "I'll tell her we're doing dinner, just us", timestamp: createDate(2, 22, 20, 0), sender: "You", sentiment: "neutral" },
          { id: "3-4-2", message: "Perfect, then everyone hides in the back", timestamp: createDate(2, 22, 20, 2), sender: "Taylor", sentiment: "positive" },
          { id: "3-4-3", message: "I'll text the group when we're 5 min away", timestamp: createDate(2, 22, 20, 5), sender: "You", sentiment: "neutral" },
          { id: "3-4-4", message: "This is going to be so good, she has no idea", timestamp: createDate(2, 22, 20, 8), sender: "Taylor", sentiment: "positive" },
        ]
      }
    ]
  },
  {
    id: "4",
    title: "Apartment Hunt",
    description: "Finding a new place in the city. Comparing neighborhoods and scheduling viewings for potential apartments.",
    startDate: createDate(2, 20, 11, 0),
    endDate: createDate(2, 20, 15, 30),
    color: "#8b5cf6",
    subtopics: [
      {
        id: "4-1",
        title: "Neighborhood Comparison",
        summary: "Weighing pros and cons of different areas",
        timeRange: "11:00 AM - 12:00 PM",
        moments: [
          { id: "4-1-1", message: "Mission has better restaurants but Hayes Valley is quieter", timestamp: createDate(2, 20, 11, 0), sender: "You", sentiment: "neutral" },
          { id: "4-1-2", message: "What's the price difference?", timestamp: createDate(2, 20, 11, 2), sender: "Sam", sentiment: "neutral" },
          { id: "4-1-3", message: "About $300/month more in Hayes Valley", timestamp: createDate(2, 20, 11, 5), sender: "You", sentiment: "negative" },
          { id: "4-1-4", message: "That adds up over a year", timestamp: createDate(2, 20, 11, 8), sender: "Sam", sentiment: "negative" },
          { id: "4-1-5", message: "But the commute is way better from Hayes", timestamp: createDate(2, 20, 11, 12), sender: "You", sentiment: "positive" },
          { id: "4-1-6", message: "True, you'd save on transit", timestamp: createDate(2, 20, 11, 15), sender: "Sam", sentiment: "positive" },
        ]
      },
      {
        id: "4-2",
        title: "Viewing Schedule",
        summary: "Setting up apartment tours",
        timeRange: "3:00 PM - 3:30 PM",
        moments: [
          { id: "4-2-1", message: "I booked 3 viewings for Saturday", timestamp: createDate(2, 20, 15, 0), sender: "Sam", sentiment: "positive" },
          { id: "4-2-2", message: "What times?", timestamp: createDate(2, 20, 15, 1), sender: "You", sentiment: "neutral" },
          { id: "4-2-3", message: "10am, 12pm, and 2pm", timestamp: createDate(2, 20, 15, 2), sender: "Sam", sentiment: "neutral" },
          { id: "4-2-4", message: "Perfect, we can grab lunch in between", timestamp: createDate(2, 20, 15, 5), sender: "You", sentiment: "positive" },
          { id: "4-2-5", message: "There's a great taco spot near the 12pm one", timestamp: createDate(2, 20, 15, 8), sender: "Sam", sentiment: "positive" },
        ]
      }
    ]
  }
]

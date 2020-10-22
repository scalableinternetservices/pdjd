import { readFileSync } from 'fs'
import { PubSub } from 'graphql-yoga'
import path from 'path'
import { check } from '../../../common/src/util'
import { Building } from '../entities/Building'
import { Event } from '../entities/Event'
import { Request } from '../entities/Request'
import { Survey } from '../entities/Survey'
import { SurveyAnswer } from '../entities/SurveyAnswer'
import { SurveyQuestion } from '../entities/SurveyQuestion'
import { User } from '../entities/User'
import { EventStatus, RequestStatus, Resolvers } from './schema.types'

export const pubsub = new PubSub()

export function getSchema() {
  const schema = readFileSync(path.join(__dirname, 'schema.graphql'))
  return schema.toString()
}

interface Context {
  user: User | null
  request: Request
  response: Response
  pubsub: PubSub
}

export const graphqlRoot: Resolvers<Context> = {
  Query: {
    self: (_, args, ctx) => ctx.user,
    survey: async (_, { surveyId }) => (await Survey.findOne({ where: { id: surveyId } })) || null,
    surveys: () => Survey.find(),
    building: async (_, { buildingID }) =>
      (await Building.findOne({ where: { id: buildingID }, relations: ['locations'] })) || null,
    buildings: () => Building.find(),
    userProfile: async (_, { id }) =>
      (await User.findOne({
        where: { id },
        relations: ['hostEvents', 'guestEvents'],
      })) || null,
    userHostRequests: async (_, { id }) =>
      (await Request.find({
        where: { host: id },
        relations: ['event', 'host', 'guest'],
      })) || null,
    userGuestRequests: async (_, { id }) =>
      (await Request.find({
        where: { guest: id },
        relations: ['event', 'host', 'guest'],
      })) || null,
    activeEvents: () =>
      Event.find({
        where: { eventStatus: EventStatus.Open },
        relations: ['host', 'location', 'location.building'],
      }), // find only open events
  },
  Mutation: {
    answerSurvey: async (_, { input }, ctx) => {
      const { answer, questionId } = input
      const question = check(await SurveyQuestion.findOne({ where: { id: questionId }, relations: ['survey'] }))

      const surveyAnswer = new SurveyAnswer()
      surveyAnswer.question = question
      surveyAnswer.answer = answer
      await surveyAnswer.save()

      question.survey.currentQuestion?.answers.push(surveyAnswer)
      ctx.pubsub.publish('SURVEY_UPDATE_' + question.survey.id, question.survey)

      return true
    },
    nextSurveyQuestion: async (_, { surveyId }, ctx) => {
      // check(ctx.user?.userType === UserType.Admin)
      const survey = check(await Survey.findOne({ where: { id: surveyId } }))
      survey.currQuestion = survey.currQuestion == null ? 0 : survey.currQuestion + 1
      await survey.save()
      ctx.pubsub.publish('SURVEY_UPDATE_' + surveyId, survey)
      return survey
    },
    acceptRequest: async (_, { requestId }) => {
      // todo: 1. put everything in a transaction 2. check if reaching attendee limit already 3. should not allow a user to attend same event twice
      const request = check(
        await Request.findOne({ where: { id: requestId }, relations: ['event', 'guest', 'guest.guestEvents'] })
      )
      request.requestStatus = RequestStatus.Accepted

      const event = request.event
      event.guestCount += 1

      const guest = request.guest
      guest.guestEvents.push(event)

      await request.save()
      await event.save()
      await guest.save()
      return true
    },
    rejectRequest: async (_, { requestId }) => {
      const request = check(await Request.findOne({ where: { id: requestId } }))
      request.requestStatus = RequestStatus.Rejected
      await request.save()
      return true
    },
    // static findOne<T extends BaseEntity>(this: ObjectType<T>, options?: FindOneOptions<T>): Promise<T | undefined>;

    // static create<T extends BaseEntity>(this: ObjectType<T>, entityLikeArray: DeepPartial<T>[]): T[];

    createEvent: async (_, { event_input }, ctx) => {
      // const event = check(await Event.create({ id: event_input.eventId }))

      const event = new Event()
      event.id = event_input.eventId
      event.title = event_input.eventTitle
      event.description = event_input.eventDesc
      event.startTime = event_input.eventStartTime
      event.endTime = event_input.eventEndTime
      event.maxGuestCount = event_input.eventMaxGuestCount

      const myEvent = check(await Event.create(event))
      await myEvent.save()
      ctx.pubsub.publish('NEW_EVENT_' + event_input, myEvent)
      return myEvent

      //pubsub.publish(SOMETHING_CHANGED_TOPIC, { somethingChanged: { id: "123" }});
    },
  },
  Subscription: {
    surveyUpdates: {
      subscribe: (_, { surveyId }, context) => context.pubsub.asyncIterator('SURVEY_UPDATE_' + surveyId),
      resolve: (payload: any) => payload,
    },
  },
}

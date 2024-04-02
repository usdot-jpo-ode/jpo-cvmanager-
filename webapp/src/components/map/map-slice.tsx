import { AnyAction, createAsyncThunk, createSlice, PayloadAction, ThunkDispatch } from '@reduxjs/toolkit'
import { RootState } from '../../store'
import { selectToken } from '../../generalSlices/userSlice'
import { Client, CompatClient, IMessage, Stomp } from '@stomp/stompjs'
import MessageMonitorApi from '../../apis/mm-api'
import EventsApi from '../../apis/events-api'
import NotificationApi from '../../apis/notification-api'
import toast from 'react-hot-toast'
import {
  generateSignalStateFeatureCollection,
  parseBsmToGeojson,
  parseMapSignalGroups,
  parseSpatSignalGroups,
} from './utilities/message-utils'
import { generateColorDictionary, generateMapboxStyleExpression } from './utilities/colors'
import { setBsmCircleColor, setBsmLegendColors } from './map-layer-style-slice'
import { getTimeRange } from './utilities/map-utils'
import { ViewState } from 'react-map-gl'
import JSZip from 'jszip'
import FileSaver from 'file-saver'
import { features } from 'process'
import {
  getMapData,
  selectMapDate,
  selectMapList,
  selectRsu,
  selectRsuData,
  selectRsuIpv4,
  selectRsuMapData,
  selectSelectedRsu,
  selectSelectedSrm,
  selectSrmSsmList,
  selectSsmDisplay,
} from '../../generalSlices/rsuSlice'
import { RsuInfo } from '../../apis/rsu-api-types'
import EnvironmentVars from '../../EnvironmentVars'

export type MAP_LAYERS =
  | 'mapMessage'
  | 'mapMessageLabels'
  | 'connectingLanes'
  | 'connectingLanesLabels'
  | 'invalidLaneCollection'
  | 'bsm'
  | 'signalStates'

export type MAP_QUERY_PARAMS = {
  startDate: Date
  endDate: Date
  eventDate: Date
  vehicleId?: string
  intersectionId?: number
  roadRegulatorId?: number
}

export type IMPORTED_MAP_MESSAGE_DATA = {
  mapData: ProcessedMap[]
  bsmData: OdeBsmData[]
  spatData: ProcessedSpat[]
  notificationData: any
}

type timestamp = {
  timestamp: number
}

export const MAP_PROPS_SOURCE_API = ['conflictvisualizer', 'cvmanager'] as const

export type MAP_PROPS = {
  sourceApi: (typeof MAP_PROPS_SOURCE_API)[number]
  sourceData:
    | MessageMonitor.Notification
    | MessageMonitor.Event
    | Assessment
    | timestamp
    | RsuInfo['rsuList'][0]
    | undefined
  sourceDataType: 'notification' | 'event' | 'assessment' | 'timestamp' | 'rsu_ip' | undefined
  intersectionId: number | undefined
  roadRegulatorId: number | undefined
  loadOnNull?: boolean
}

type RAW_MESSAGE_DATA_EXPORT = {
  map?: ProcessedMap[]
  spat?: ProcessedSpat[]
  bsm?: BsmFeatureCollection
  notification?: MessageMonitor.Notification
  event?: MessageMonitor.Event
  assessment?: Assessment
}

interface MinimalClient {
  connect: (headers: unknown, connectCallback: () => void, errorCallback?: (error: string) => void) => void
  subscribe: (destination: string, callback: (message: IMessage) => void) => void
  disconnect: (disconnectCallback: () => void) => void
}

const initialState = {
  layersVisible: {
    mapMessage: false,
    mapMessageLabels: false,
    connectingLanes: false,
    connectingLanesLabels: false,
    invalidLaneCollection: false,
    bsm: false,
    signalStates: false,
  } as Record<MAP_LAYERS, boolean>,
  allInteractiveLayerIds: ['mapMessage', 'connectingLanes', 'signalStates', 'bsm'] as MAP_LAYERS[],
  queryParams: {
    startDate: new Date(Date.now() - 1000 * 60 * 1),
    endDate: new Date(Date.now() + 1000 * 60 * 1),
    eventDate: new Date(Date.now()),
    vehicleId: undefined,
    intersectionId: undefined,
    roadRegulatorId: undefined,
  } as MAP_QUERY_PARAMS,
  sourceApi: undefined as MAP_PROPS['sourceApi'] | undefined,
  sourceData: undefined as MAP_PROPS['sourceData'] | undefined,
  sourceDataType: undefined as MAP_PROPS['sourceDataType'] | undefined,
  intersectionId: undefined as MAP_PROPS['intersectionId'] | undefined,
  roadRegulatorId: undefined as MAP_PROPS['roadRegulatorId'] | undefined,
  loadOnNull: true as MAP_PROPS['loadOnNull'] | undefined,
  mapData: undefined as ProcessedMap | undefined,
  mapSignalGroups: undefined as SignalStateFeatureCollection | undefined,
  signalStateData: undefined as SignalStateFeatureCollection | undefined,
  spatSignalGroups: undefined as SpatSignalGroups | undefined,
  currentSignalGroups: undefined as SpatSignalGroup[] | undefined,
  currentBsms: {
    type: 'FeatureCollection' as 'FeatureCollection',
    features: [],
  } as BsmUiFeatureCollection,
  connectingLanes: undefined as ConnectingLanesFeatureCollection | undefined,
  bsmData: {
    type: 'FeatureCollection' as 'FeatureCollection',
    features: [],
  } as BsmFeatureCollection,
  surroundingEvents: [] as MessageMonitor.Event[],
  filteredSurroundingEvents: [] as MessageMonitor.Event[],
  surroundingNotifications: [] as MessageMonitor.Notification[],
  filteredSurroundingNotifications: [] as MessageMonitor.Notification[],
  viewState: {
    latitude: 39.587905,
    longitude: -105.0907089,
    zoom: 19,
  },
  timeWindowSeconds: 60,
  sliderValue: 0,
  sliderTimeValue: {
    start: new Date(),
    end: new Date(),
  },
  lastSliderUpdate: undefined as number | undefined,
  renderTimeInterval: [0, 0],
  hoveredFeature: undefined as any,
  selectedFeature: undefined as any,
  rawData: {} as RAW_MESSAGE_DATA_EXPORT,
  mapSpatTimes: { mapTime: 0, spatTime: 0 },
  sigGroupLabelsVisible: false,
  laneLabelsVisible: false,
  showPopupOnHover: false,
  importedMessageData: undefined as IMPORTED_MAP_MESSAGE_DATA | undefined,
  cursor: 'default',
  loadInitialDataTimeoutId: undefined as NodeJS.Timeout | undefined,
  wsClient: undefined as MinimalClient | undefined,
  liveDataActive: false,
  currentMapData: [] as ProcessedMap[],
  currentSpatData: [] as ProcessedSpat[],
  currentBsmData: {
    type: 'FeatureCollection',
    features: [],
  } as BsmFeatureCollection,
  bsmTrailLength: 20,
}

const getNewSliderTimeValue = (startDate: Date, sliderValue: number, timeWindowSeconds: number) => {
  return {
    start: new Date((startDate.getTime() / 1000 + sliderValue - timeWindowSeconds) * 1000),
    end: new Date((startDate.getTime() / 1000 + sliderValue) * 1000),
  }
}

export const pullInitialData = createAsyncThunk(
  'intersectionMap/pullInitialData',
  async (_, { getState, dispatch }) => {
    const currentState = getState() as RootState
    const authToken = selectToken(currentState)!
    const importedMessageData = selectImportedMessageData(currentState)
    const queryParams = selectQueryParams(currentState)

    console.debug('Pulling Initial Data')
    let rawMap: ProcessedMap[] = []
    let rawSpat: ProcessedSpat[] = []
    let rawBsm: OdeBsmData[] = []
    if (!importedMessageData) {
      // ######################### Retrieve MAP Data #########################
      const rawMapPromise = MessageMonitorApi.getMapMessages({
        token: authToken,
        intersectionId: queryParams.intersectionId!,
        roadRegulatorId: queryParams.roadRegulatorId!,
        //startTime: new Date(queryParams.startDate.getTime() - 1000 * 60 * 60 * 1),
        endTime: queryParams.endDate,
        latest: true,
      })
      toast.promise(rawMapPromise, {
        loading: `Loading MAP Data`,
        success: `Successfully got MAP Data`,
        error: `Failed to get MAP data. Please see console`,
      })
      rawMap = await rawMapPromise

      // ######################### Retrieve SPAT Data #########################
      const rawSpatPromise = MessageMonitorApi.getSpatMessages({
        token: authToken,
        intersectionId: queryParams.intersectionId!,
        roadRegulatorId: queryParams.roadRegulatorId!,
        startTime: queryParams.startDate,
        endTime: queryParams.endDate,
      })
      toast.promise(rawSpatPromise, {
        loading: `Loading SPAT Data`,
        success: `Successfully got SPAT Data`,
        error: `Failed to get SPAT data. Please see console`,
      })
      rawSpat = (await rawSpatPromise).sort((a, b) => Number(a.utcTimeStamp) - Number(b.utcTimeStamp))

      dispatch(getSurroundingEvents())
      dispatch(getSurroundingNotifications())
    } else {
      rawMap = importedMessageData.mapData
      rawSpat = importedMessageData.spatData.sort((a, b) => Number(a.utcTimeStamp) - Number(b.utcTimeStamp))
      rawBsm = importedMessageData.bsmData
    }
    if (!rawMap || rawMap.length == 0) {
      console.info('NO MAP MESSAGES WITHIN TIME')
      // return;
    }

    const latestMapMessage: ProcessedMap = rawMap.at(-1)!
    const mapCoordinates: OdePosition3D = latestMapMessage?.properties.refPoint
    const mapSignalGroupsLocal = parseMapSignalGroups(latestMapMessage)
    const spatSignalGroupsLocal = parseSpatSignalGroups(rawSpat)

    // ######################### BSMs #########################
    if (!importedMessageData) {
      const rawBsmPromise = MessageMonitorApi.getBsmMessages({
        token: authToken,
        vehicleId: queryParams.vehicleId,
        startTime: queryParams.startDate,
        endTime: queryParams.endDate,
        long: mapCoordinates.longitude,
        lat: mapCoordinates.latitude,
        distance: 500,
      })
      toast.promise(rawBsmPromise, {
        loading: `Loading BSM Data`,
        success: `Successfully got BSM Data`,
        error: `Failed to get BSM data. Please see console`,
      })
      rawBsm = await rawBsmPromise
    }
    let bsmGeojson = parseBsmToGeojson(rawBsm)
    bsmGeojson = {
      ...bsmGeojson,
      features: [...bsmGeojson.features.sort((a, b) => b.properties.odeReceivedAt - a.properties.odeReceivedAt)],
    }
    dispatch(renderEntireMap({ currentMapData: rawMap, currentSpatData: rawSpat, currentBsmData: bsmGeojson }))
    return {
      mapData: latestMapMessage,
      connectingLanes: latestMapMessage.connectingLanesFeatureCollection,
      spatSignalGroups: spatSignalGroupsLocal,
      mapSignalGroups: mapSignalGroupsLocal,
      mapTime: latestMapMessage.properties.odeReceivedAt as unknown as number,
    }
  },
  {
    condition: (_, { getState }) =>
      selectToken(getState() as RootState) != undefined &&
      selectQueryParams(getState() as RootState).intersectionId != undefined &&
      selectQueryParams(getState() as RootState).roadRegulatorId != undefined &&
      (selectSourceData(getState() as RootState) != undefined || selectLoadOnNull(getState() as RootState) == true),
  }
)

export const renderEntireMap = createAsyncThunk(
  'intersectionMap/renderEntireMap',
  async (
    args: { currentMapData: ProcessedMap[]; currentSpatData: ProcessedSpat[]; currentBsmData: BsmFeatureCollection },
    { getState, dispatch }
  ) => {
    const { currentMapData, currentSpatData, currentBsmData } = args
    const currentState = getState() as RootState
    const sourceApi = selectSourceApi(currentState)

    if (sourceApi == 'conflictvisualizer') {
      const queryParams = selectQueryParams(currentState)
      const sourceData = selectSourceData(currentState)
      const sourceDataType = selectSourceDataType(currentState)

      // ######################### MAP Data #########################
      const latestMapMessage: ProcessedMap = currentMapData.at(-1)!

      // ######################### SPAT Signal Groups #########################
      const mapSignalGroupsLocal = parseMapSignalGroups(latestMapMessage)

      const spatSignalGroupsLocal = parseSpatSignalGroups(currentSpatData)

      const uniqueIds = new Set(currentBsmData.features.map((bsm) => bsm.properties?.id))
      // generate equally spaced unique colors for each uniqueId
      const colors = generateColorDictionary(uniqueIds)
      dispatch(setBsmLegendColors(colors))
      // add color to each feature
      const bsmLayerStyle = generateMapboxStyleExpression(colors)
      dispatch(setBsmCircleColor(bsmLayerStyle))

      // ######################### Message Data #########################
      const rawData = {}
      rawData['map'] = currentMapData
      rawData['spat'] = currentSpatData
      rawData['bsm'] = currentBsmData
      if (sourceDataType == 'notification') {
        rawData['notification'] = sourceData as MessageMonitor.Notification
      } else if (sourceDataType == 'event') {
        rawData['event'] = sourceData as MessageMonitor.Event
      } else if (sourceDataType == 'assessment') {
        rawData['assessment'] = sourceData as Assessment
      }
      return {
        connectingLanes: latestMapMessage.connectingLanesFeatureCollection,
        mapData: latestMapMessage,
        mapTime: latestMapMessage.properties.odeReceivedAt as unknown as number,
        mapSignalGroups: mapSignalGroupsLocal,
        spatSignalGroups: spatSignalGroupsLocal,
        bsmData: currentBsmData,
        rawData: rawData,
        sliderValue: Math.min(
          getTimeRange(queryParams.startDate, queryParams.eventDate ?? new Date()),
          getTimeRange(queryParams.startDate, queryParams.endDate)
        ),
      }
    } else if (sourceApi == 'cvmanager') {
      const queryParams = selectQueryParams(currentState)
      const sourceData = selectSourceData(currentState)
      const sourceDataType = selectSourceDataType(currentState)

      // ######################### MAP Data #########################
      const latestMapMessage: ProcessedMap = currentMapData.at(-1)!

      // ######################### SPAT Signal Groups #########################
      const mapSignalGroupsLocal = parseMapSignalGroups(latestMapMessage)

      const spatSignalGroupsLocal = parseSpatSignalGroups(currentSpatData)

      const uniqueIds = new Set(currentBsmData.features.map((bsm) => bsm.properties?.id))
      // generate equally spaced unique colors for each uniqueId
      const colors = generateColorDictionary(uniqueIds)
      dispatch(setBsmLegendColors(colors))
      // add color to each feature
      const bsmLayerStyle = generateMapboxStyleExpression(colors)
      dispatch(setBsmCircleColor(bsmLayerStyle))

      // ######################### Message Data #########################
      const rawData = {}
      rawData['map'] = currentMapData
      rawData['spat'] = currentSpatData
      rawData['bsm'] = currentBsmData
      if (sourceDataType == 'rsu_ip') {
        const mapList = selectMapList(currentState)
        const rsu = sourceData as RsuInfo['rsuList'][0]
        if (rsu != null && mapList.includes(rsu.properties.ipv4_address)) {
          dispatch(getMapData())
          dispatch(selectRsu(rsu))
        }
      }
      return {
        connectingLanes: latestMapMessage.connectingLanesFeatureCollection,
        mapData: latestMapMessage,
        mapTime: latestMapMessage.properties.odeReceivedAt as unknown as number,
        mapSignalGroups: mapSignalGroupsLocal,
        spatSignalGroups: spatSignalGroupsLocal,
        bsmData: currentBsmData,
        rawData: rawData,
        sliderValue: Math.min(
          getTimeRange(queryParams.startDate, queryParams.eventDate ?? new Date()),
          getTimeRange(queryParams.startDate, queryParams.endDate)
        ),
      }
    }
  },
  {
    condition: (
      args: { currentMapData: ProcessedMap[]; currentSpatData: ProcessedSpat[]; currentBsmData: BsmFeatureCollection },
      { getState }
    ) => args.currentMapData.length != 0,
  }
)

export const renderIterative_Map = createAsyncThunk(
  'intersectionMap/renderIterative_Map',
  async (newMapData: ProcessedMap[], { getState, dispatch }) => {
    const currentState = getState() as RootState
    const queryParams = selectQueryParams(currentState)
    const currentMapData: ProcessedMap[] = selectCurrentMapData(currentState)

    const start = Date.now()
    const OLDEST_DATA_TO_KEEP = queryParams.eventDate.getTime() - queryParams.startDate.getTime() // milliseconds

    const currTimestamp = Date.parse(newMapData.at(-1)!.properties.odeReceivedAt) / 1000
    let oldIndex = 0
    for (let i = 0; i < currentMapData.length; i++) {
      if ((currentMapData[i].properties.odeReceivedAt as unknown as number) < currTimestamp - OLDEST_DATA_TO_KEEP) {
        oldIndex = i
      } else {
        break
      }
    }
    const currentMapDataLocal = currentMapData.slice(oldIndex, currentMapData.length).concat(newMapData)

    // ######################### MAP Data #########################
    const latestMapMessage: ProcessedMap = currentMapDataLocal.at(-1)!

    // ######################### SPAT Signal Groups #########################
    const mapSignalGroupsLocal = parseMapSignalGroups(latestMapMessage)
    console.debug('MAP RENDER TIME:', Date.now() - start, 'ms')
    dispatch(setRawData({ map: currentMapDataLocal }))
    return {
      currentMapData: currentMapDataLocal,
      connectingLanes: latestMapMessage.connectingLanesFeatureCollection,
      mapData: latestMapMessage,
      mapTime: currTimestamp,
      mapSignalGroups: mapSignalGroupsLocal,
    }
  },
  {
    condition: (newMapData: ProcessedMap[], { getState }) => newMapData.length != 0,
  }
)

export const renderIterative_Spat = createAsyncThunk(
  'intersectionMap/renderIterative_Spat',
  async (newSpatData: ProcessedSpat[], { getState, dispatch }) => {
    const currentState = getState() as RootState
    const queryParams = selectQueryParams(currentState)
    const currentSpatSignalGroups: ProcessedSpat[] = selectCurrentSpatData(currentState)
    const OLDEST_DATA_TO_KEEP = queryParams.eventDate.getTime() - queryParams.startDate.getTime() // milliseconds
    // Inject and filter spat data
    const currTimestamp = Date.parse(newSpatData.at(-1)!.utcTimeStamp)
    let oldIndex = 0
    const currentSpatSignalGroupsArr = Object.keys(currentSpatSignalGroups).map((key) => ({
      key,
      sigGroup: currentSpatSignalGroups[key],
    }))
    for (let i = 0; i < currentSpatSignalGroupsArr.length; i++) {
      if (Number(currentSpatSignalGroupsArr[i].key) < currTimestamp - OLDEST_DATA_TO_KEEP) {
        oldIndex = i
      } else {
        break
      }
    }
    const newSpatSignalGroups = parseSpatSignalGroups(newSpatData)
    const newSpatSignalGroupsArr = Object.keys(newSpatSignalGroups).map((key) => ({
      key,
      sigGroup: newSpatSignalGroups[key],
    }))
    const filteredSpatSignalGroupsArr = currentSpatSignalGroupsArr
      .slice(oldIndex, currentSpatSignalGroupsArr.length)
      .concat(newSpatSignalGroupsArr)
    const currentSpatSignalGroupsLocal = filteredSpatSignalGroupsArr.reduce((acc, curr) => {
      acc[curr.key] = curr.sigGroup
      return acc
    }, {} as SpatSignalGroups)

    // Update current processed spat data
    oldIndex = 0
    for (let i = 0; i < currentSpatSignalGroups.length; i++) {
      if (Date.parse(currentSpatSignalGroups[i].utcTimeStamp) < currTimestamp - OLDEST_DATA_TO_KEEP) {
        oldIndex = i
      } else {
        break
      }
    }
    const currentProcessedSpatDataLocal = currentSpatSignalGroups
      .slice(oldIndex, currentSpatSignalGroups.length)
      .concat(newSpatData)
    dispatch(setRawData({ spat: currentProcessedSpatDataLocal }))

    return {
      currentProcessedSpatDataLocal,
      currentSpatSignalGroupsLocal,
    }
  },
  {
    condition: (newSpatData: ProcessedSpat[], { getState }) => newSpatData.length != 0,
  }
)

export const renderIterative_Bsm = createAsyncThunk(
  'intersectionMap/renderIterative_Bsm',
  async (newBsmData: OdeBsmData[], { getState, dispatch }) => {
    const currentState = getState() as RootState
    const queryParams = selectQueryParams(currentState)
    const currentBsmData: BsmFeatureCollection = selectCurrentBsmData(currentState)

    const OLDEST_DATA_TO_KEEP = queryParams.eventDate.getTime() - queryParams.startDate.getTime() // milliseconds
    // Inject and filter spat data
    const currTimestamp = new Date(newBsmData.at(-1)!.metadata.odeReceivedAt as string).getTime() / 1000
    let oldIndex = 0
    for (let i = 0; i < currentBsmData.features.length; i++) {
      if (Number(currentBsmData.features[i].properties.odeReceivedAt) < currTimestamp - OLDEST_DATA_TO_KEEP) {
        oldIndex = i
      } else {
        break
      }
    }
    const newBsmGeojson = parseBsmToGeojson(newBsmData)
    const currentBsmGeojson = {
      ...currentBsmData,
      features: currentBsmData.features.slice(oldIndex, currentBsmData.features.length).concat(newBsmGeojson.features),
    }

    const uniqueIds = new Set(currentBsmGeojson.features.map((bsm) => bsm.properties?.id))
    // generate equally spaced unique colors for each uniqueId
    const colors = generateColorDictionary(uniqueIds)
    dispatch(setBsmLegendColors(colors))
    // add color to each feature
    const bsmLayerStyle = generateMapboxStyleExpression(colors)
    dispatch(setBsmCircleColor(bsmLayerStyle))
    dispatch(setRawData({ bsm: currentBsmGeojson }))
    return currentBsmGeojson
  },
  {
    condition: (newBsmData: OdeBsmData[], { getState }) => newBsmData.length != 0,
  }
)

export const getSurroundingEvents = createAsyncThunk(
  'intersectionMap/getSurroundingEvents',
  async (_, { getState }) => {
    const currentState = getState() as RootState
    const authToken = selectToken(currentState)!
    const queryParams = selectQueryParams(currentState)

    const surroundingEventsPromise = EventsApi.getAllEvents(
      authToken,
      queryParams.intersectionId!,
      queryParams.roadRegulatorId!,
      queryParams.startDate,
      queryParams.endDate
    )
    toast.promise(surroundingEventsPromise, {
      loading: `Loading Event Data`,
      success: `Successfully got Event Data`,
      error: `Failed to get Event data. Please see console`,
    })
    return surroundingEventsPromise
  },
  {
    condition: (_, { getState }) =>
      selectToken(getState() as RootState) != undefined &&
      selectQueryParams(getState() as RootState).intersectionId != undefined &&
      selectQueryParams(getState() as RootState).roadRegulatorId != undefined,
  }
)

export const getSurroundingNotifications = createAsyncThunk(
  'intersectionMap/getSurroundingNotifications',
  async (_, { getState }) => {
    const currentState = getState() as RootState
    const authToken = selectToken(currentState)!
    const queryParams = selectQueryParams(currentState)

    const surroundingNotificationsPromise = NotificationApi.getAllNotifications({
      token: authToken,
      intersectionId: queryParams.intersectionId!,
      roadRegulatorId: queryParams.roadRegulatorId!,
      startTime: queryParams.startDate,
      endTime: queryParams.endDate,
    })
    toast.promise(surroundingNotificationsPromise, {
      loading: `Loading Notification Data`,
      success: `Successfully got Notification Data`,
      error: `Failed to get Notification data. Please see console`,
    })
    return surroundingNotificationsPromise
  },
  {
    condition: (_, { getState }) =>
      selectToken(getState() as RootState) != undefined &&
      selectQueryParams(getState() as RootState).intersectionId != undefined &&
      selectQueryParams(getState() as RootState).roadRegulatorId != undefined,
  }
)

export const initializeLiveStreaming = createAsyncThunk(
  'intersectionMap/initializeLiveStreaming',
  async (args: { token: string; roadRegulatorId: number; intersectionId: number }, { getState, dispatch }) => {
    const { token, roadRegulatorId, intersectionId } = args
    // Connect to WebSocket when component mounts
    dispatch(onTimeQueryChanged({ eventTime: new Date(), timeBefore: 10, timeAfter: 0, timeWindowSeconds: 2 }))

    let protocols = ['v10.stomp', 'v11.stomp']
    protocols.push(token)
    const url = `${EnvironmentVars.CVIZ_API_WS_URL}/stomp`
    console.debug('Connecting to STOMP endpoint: ' + url + ' with token: ' + token)

    // Stomp Client Documentation: https://stomp-js.github.io/stomp-websocket/codo/extra/docs-src/Usage.md.html
    let client = Stomp.client(url, protocols)
    client.debug = () => {}

    // Topics are in the format /live/{roadRegulatorID}/{intersectionID}/{spat,map,bsm}
    let spatTopic = `/live/${roadRegulatorId}/${intersectionId}/spat`
    let mapTopic = `/live/${roadRegulatorId}/${intersectionId}/map`
    let bsmTopic = `/live/${roadRegulatorId}/${intersectionId}/bsm` // TODO: Filter by road regulator ID
    let spatTime = Date.now()
    let mapTime = Date.now()
    let bsmTime = Date.now()
    client.connect(
      {
        // "username": "test",
        // "password": "test",
        // Token: token,
      },
      () => {
        client.subscribe(spatTopic, function (mes: IMessage) {
          const spatMessage: ProcessedSpat = JSON.parse(mes.body)
          console.debug('Received SPaT message ' + (Date.now() - spatTime) + ' ms')
          spatTime = Date.now()
          dispatch(renderIterative_Spat([spatMessage]))
          dispatch(maybeUpdateSliderValue())
        })

        client.subscribe(mapTopic, function (mes: IMessage) {
          const mapMessage: ProcessedMap = JSON.parse(mes.body)
          console.debug('Received MAP message ' + (Date.now() - mapTime) + ' ms')
          mapTime = Date.now()
          dispatch(renderIterative_Map([mapMessage]))
          dispatch(maybeUpdateSliderValue())
        })

        client.subscribe(bsmTopic, function (mes: IMessage) {
          const bsmData: OdeBsmData = JSON.parse(mes.body)
          console.debug('Received BSM message ' + (Date.now() - bsmTime) + ' ms')
          bsmTime = Date.now()
          dispatch(renderIterative_Bsm([bsmData]))
          dispatch(maybeUpdateSliderValue())
        })
      },
      (error) => {
        console.error('ERROR connecting to live data Websockets', error)
      }
    )
  }
)

export const updateRenderedMapState = createAsyncThunk(
  'intersectionMap/updateRenderedMapState',
  async (_, { getState, dispatch }) => {
    const currentState = getState() as RootState
    const authToken = selectToken(currentState)!
    const queryParams = selectQueryParams(currentState)
    const spatSignalGroups = selectSpatSignalGroups(currentState)
    const mapSignalGroups = selectMapSignalGroups(currentState)
    const renderTimeInterval = selectRenderTimeInterval(currentState)
    const bsmData = selectBsmData(currentState)
    const bsmTrailLength = selectBsmTrailLength(currentState)
    const surroundingEvents = selectSurroundingEvents(currentState)
    const surroundingNotifications = selectSurroundingNotifications(currentState)

    // ASSUMPTION: mapSignalGroups && spatSignalGroups

    let currentSignalGroups: SpatSignalGroup[] | undefined
    let signalStateData: SignalStateFeatureCollection | undefined
    let spatTime: number | undefined

    // retrieve filtered SPATs
    let closestSignalGroup: { spat: SpatSignalGroup[]; datetime: number } | null = null
    for (const datetime in spatSignalGroups) {
      const datetimeNum = Number(datetime) / 1000 // milliseconds to seconds
      if (datetimeNum >= renderTimeInterval[0] && datetimeNum <= renderTimeInterval[1]) {
        if (
          closestSignalGroup === null ||
          Math.abs(datetimeNum - renderTimeInterval[1]) < Math.abs(closestSignalGroup.datetime - renderTimeInterval[1])
        ) {
          closestSignalGroup = { datetime: datetimeNum, spat: spatSignalGroups[datetime] }
        }
      }
    }
    if (closestSignalGroup !== null) {
      currentSignalGroups = closestSignalGroup.spat
      signalStateData = generateSignalStateFeatureCollection(mapSignalGroups!, closestSignalGroup.spat)
      spatTime = closestSignalGroup.datetime
    }

    // retrieve filtered BSMs
    const filteredBsms: BsmFeature[] = bsmData?.features?.filter(
      (feature) =>
        feature.properties?.odeReceivedAt >= renderTimeInterval[0] &&
        feature.properties?.odeReceivedAt <= renderTimeInterval[1]
    )
    const sortedBsms = filteredBsms.sort((a, b) => b.properties.odeReceivedAt - a.properties.odeReceivedAt)
    const lastBsms = sortedBsms.slice(0, bsmTrailLength) // Apply BSM trail length
    const currentBsms = { ...bsmData, features: lastBsms }

    // Update BSM legend colors
    const uniqueIds = new Set(filteredBsms.map((bsm) => bsm.properties?.id))
    const colors = generateColorDictionary(uniqueIds)

    dispatch(setBsmLegendColors(colors))
    const bsmLayerStyle = generateMapboxStyleExpression(colors)
    dispatch(setBsmCircleColor(bsmLayerStyle))

    const filteredEvents: MessageMonitor.Event[] = surroundingEvents.filter(
      (event) =>
        event.eventGeneratedAt / 1000 >= renderTimeInterval[0] && event.eventGeneratedAt / 1000 <= renderTimeInterval[1]
    )

    const filteredNotifications: MessageMonitor.Notification[] = surroundingNotifications.filter(
      (notification) =>
        notification.notificationGeneratedAt / 1000 >= renderTimeInterval[0] &&
        notification.notificationGeneratedAt / 1000 <= renderTimeInterval[1]
    )

    return {
      currentSignalGroups: closestSignalGroup?.spat,
      signalStateData: closestSignalGroup
        ? generateSignalStateFeatureCollection(mapSignalGroups!, closestSignalGroup?.spat)
        : undefined,
      spatTime: closestSignalGroup?.datetime,
      currentBsms,
      filteredSurroundingEvents: filteredEvents,
      filteredSurroundingNotifications: filteredNotifications,
    }
  },
  {
    condition: (_, { getState }) =>
      selectToken(getState() as RootState) != undefined &&
      selectQueryParams(getState() as RootState).intersectionId != undefined &&
      selectQueryParams(getState() as RootState).roadRegulatorId != undefined,
  }
)

const compareQueryParams = (oldParams: MAP_QUERY_PARAMS, newParams: MAP_QUERY_PARAMS) => {
  return (
    oldParams.startDate.getTime() != newParams.startDate.getTime() ||
    oldParams.endDate.getTime() != newParams.endDate.getTime() ||
    oldParams.eventDate.getTime() != newParams.eventDate.getTime() ||
    oldParams.vehicleId != newParams.vehicleId ||
    oldParams.intersectionId != newParams.intersectionId ||
    oldParams.roadRegulatorId != newParams.roadRegulatorId
  )
}

const generateRenderTimeInterval = (startDate: Date, sliderValue: number, timeWindowSeconds: number) => {
  const startTime = startDate.getTime() / 1000

  const filteredStartTime = startTime + sliderValue - timeWindowSeconds
  const filteredEndTime = startTime + sliderValue

  return [filteredStartTime, filteredEndTime]
}

const _updateQueryParams = ({
  state,
  startDate,
  endDate,
  eventDate,
  vehicleId,
  intersectionId,
  roadRegulatorId,
  resetTimeWindow,
  updateSlider,
}: {
  state: RootState['intersectionMap']
  startDate?: Date
  endDate?: Date
  eventDate?: Date
  vehicleId?: string
  intersectionId?: number
  roadRegulatorId?: number
  resetTimeWindow?: boolean
  updateSlider?: boolean
}) => {
  const newQueryParams = {
    startDate: startDate ?? state.value.queryParams.startDate,
    endDate: endDate ?? state.value.queryParams.endDate,
    eventDate: eventDate ?? state.value.queryParams.eventDate,
    vehicleId: vehicleId ?? state.value.queryParams.vehicleId,
    intersectionId: intersectionId ?? state.value.queryParams.intersectionId,
    roadRegulatorId: roadRegulatorId ?? state.value.queryParams.roadRegulatorId,
  }
  if (compareQueryParams(state.value.queryParams, newQueryParams)) {
    state.value.queryParams = newQueryParams
    state.value.sliderTimeValue = getNewSliderTimeValue(
      state.value.queryParams.startDate,
      state.value.sliderValue,
      state.value.timeWindowSeconds
    )
    if (resetTimeWindow) state.value.timeWindowSeconds = 60
    if (updateSlider) state.value.sliderValue = getTimeRange(newQueryParams.startDate, newQueryParams.endDate)
  }
}

const _downloadData = (rawData: RAW_MESSAGE_DATA_EXPORT, queryParams: MAP_QUERY_PARAMS) => {
  var zip = new JSZip()
  zip.file(`intersection_${queryParams.intersectionId}_MAP_data.json`, JSON.stringify(rawData.map))
  zip.file(`intersection_${queryParams.intersectionId}_SPAT_data.json`, JSON.stringify(rawData.spat))
  zip.file(`intersection_${queryParams.intersectionId}_BSM_data.json`, JSON.stringify(rawData.bsm))
  if (rawData.event)
    zip.file(`intersection_${queryParams.intersectionId}_Event_data.json`, JSON.stringify(rawData.event))
  if (rawData.assessment)
    zip.file(`intersection_${queryParams.intersectionId}_Assessment_data.json`, JSON.stringify(rawData.assessment))
  if (rawData.notification)
    zip.file(`intersection_${queryParams.intersectionId}_Notification_data.json`, JSON.stringify(rawData.notification))

  zip.generateAsync({ type: 'blob' }).then(function (content) {
    FileSaver.saveAs(content, `intersection_${queryParams.intersectionId}_data.zip`)
  })
}

export const downloadMapData = createAsyncThunk(
  'intersectionMap/downloadMapData',
  async (_, { getState }) => {
    const currentState = getState() as RootState
    const rawData = selectRawData(currentState)!
    const queryParams = selectQueryParams(currentState)

    return _downloadData(rawData, queryParams)
  },
  {
    condition: (_, { getState }) =>
      selectToken(getState() as RootState) != undefined &&
      selectQueryParams(getState() as RootState).intersectionId != undefined &&
      selectQueryParams(getState() as RootState).roadRegulatorId != undefined,
  }
)

export const intersectionMapSlice = createSlice({
  name: 'intersectionMap',
  initialState: {
    loading: false,
    value: initialState,
  },
  reducers: {
    updateSsmSrmCounts: (state, action: PayloadAction<string>) => {
      // let localSrmCount = 0
      // let localSsmCount = 0
      // let localMsgList = []
      // // console.error('srmSsmList', state.value.srmSsmList)
      // for (const elem of state.value.srmSsmList) {
      //   if (elem.ip === state.value.rsuIpv4) {
      //     localMsgList.push(elem)
      //     if (elem.type === 'srmTx') {
      //       localSrmCount += 1
      //     } else {
      //       localSsmCount += 1
      //     }
      //   }
      // }
      // state.value.srmCount = localSrmCount
      // state.value.srmSsmCount = localSsmCount
      // state.value.srmMsgList = localMsgList
    },
    setSurroundingEvents: (state, action: PayloadAction<MessageMonitor.Event[]>) => {
      state.value.surroundingEvents = action.payload
    },
    maybeUpdateSliderValue: (state) => {
      if (
        state.value.liveDataActive &&
        (!state.value.lastSliderUpdate || Date.now() - state.value.lastSliderUpdate > 1 * 1000)
      ) {
        _updateQueryParams({
          state,
          startDate: new Date(
            Date.now() - (state.value.queryParams.endDate.getTime() - state.value.queryParams.startDate.getTime())
          ),
          endDate: new Date(Date.now()),
          eventDate: new Date(Date.now()),
          vehicleId: undefined,
          intersectionId: state.value.queryParams.intersectionId,
          roadRegulatorId: state.value.queryParams.roadRegulatorId,
          updateSlider: true,
        })
      }
    },
    updateLiveSliderValue: (state) => {
      const newQueryParams = {
        startDate: new Date(
          Date.now() - (state.value.queryParams.endDate.getTime() - state.value.queryParams.startDate.getTime())
        ),
        endDate: new Date(Date.now()),
        eventDate: new Date(Date.now()),
        vehicleId: undefined,
        intersectionId: state.value.queryParams.intersectionId,
        roadRegulatorId: state.value.queryParams.roadRegulatorId,
      }
      state.value.queryParams = newQueryParams
      state.value.sliderValue = getTimeRange(newQueryParams.startDate, newQueryParams.endDate)
      state.value.renderTimeInterval = [
        newQueryParams.startDate.getTime() / 1000,
        newQueryParams.endDate.getTime() / 1000,
      ]
      state.value.sliderTimeValue = getNewSliderTimeValue(
        state.value.queryParams.startDate,
        state.value.sliderValue,
        state.value.timeWindowSeconds
      )
    },
    setViewState: (state, action: PayloadAction<ViewState>) => {
      state.value.viewState = action.payload
    },
    handleImportedMapMessageData: (
      state,
      action: PayloadAction<{
        mapData: ProcessedMap[]
        bsmData: OdeBsmData[]
        spatData: ProcessedSpat[]
        notificationData: any
      }>
    ) => {
      const { mapData, bsmData, spatData, notificationData } = action.payload
      const sortedSpatData = spatData.sort((x, y) => {
        if (x.utcTimeStamp < y.utcTimeStamp) {
          return 1
        }
        if (x.utcTimeStamp > y.utcTimeStamp) {
          return -1
        }
        return 0
      })
      const endTime = new Date(Date.parse(sortedSpatData[0].utcTimeStamp))
      const startTime = new Date(Date.parse(sortedSpatData[sortedSpatData.length - 1].utcTimeStamp))
      state.value.importedMessageData = { mapData, bsmData, spatData, notificationData }
      state.value.queryParams = {
        startDate: startTime,
        endDate: endTime,
        eventDate: startTime,
        intersectionId: mapData[0].properties.intersectionId,
        roadRegulatorId: -1,
      }
      state.value.timeWindowSeconds = 60
      state.value.sliderTimeValue = getNewSliderTimeValue(
        state.value.queryParams.startDate,
        state.value.sliderValue,
        state.value.timeWindowSeconds
      )
    },
    updateQueryParams: (
      state,
      action: PayloadAction<{
        startDate?: Date
        endDate?: Date
        eventDate?: Date
        vehicleId?: string
        intersectionId?: number
        roadRegulatorId?: number
        resetTimeWindow?: boolean
        updateSlider?: boolean
      }>
    ) => {
      _updateQueryParams({ state, ...action.payload })
    },
    onTimeQueryChanged: (
      state,
      action: PayloadAction<{
        eventTime?: Date
        timeBefore?: number
        timeAfter?: number
        timeWindowSeconds?: number
      }>
    ) => {
      let { eventTime, timeBefore, timeAfter, timeWindowSeconds } = action.payload
      eventTime ??= new Date()
      const updatedQueryParams = {
        startDate: new Date(eventTime.getTime() - (timeBefore ?? 0) * 1000),
        endDate: new Date(eventTime.getTime() + (timeAfter ?? 0) * 1000),
        eventDate: eventTime,
        intersectionId: state.value.queryParams.intersectionId,
        roadRegulatorId: state.value.queryParams.roadRegulatorId,
      }
      if (compareQueryParams(state.value.queryParams, updatedQueryParams)) {
        // Detected change in query params
        state.value.queryParams = updatedQueryParams
        state.value.sliderTimeValue = getNewSliderTimeValue(
          state.value.queryParams.startDate,
          state.value.sliderValue,
          state.value.timeWindowSeconds
        )
      } else {
        // No change in query params
      }
      state.value.timeWindowSeconds = timeWindowSeconds ?? state.value.timeWindowSeconds
    },
    setSliderValue: (state, action: PayloadAction<number | number[]>) => {
      state.value.sliderValue = action.payload as number
      state.value.liveDataActive = false
    },
    updateRenderTimeInterval: (state) => {
      state.value.renderTimeInterval = generateRenderTimeInterval(
        state.value.queryParams.startDate,
        state.value.sliderValue,
        state.value.timeWindowSeconds
      )
    },
    onMapClick: (
      state,
      action: PayloadAction<{
        event: { point: mapboxgl.Point; lngLat: mapboxgl.LngLat }
        mapRef: React.MutableRefObject<any>
      }>
    ) => {
      const features = action.payload.mapRef.current.queryRenderedFeatures(action.payload.event.point, {
        //   layers: allInteractiveLayerIds,
      })
      const feature = features?.[0]
      if (feature && state.value.allInteractiveLayerIds.includes(feature.layer.id)) {
        state.value.selectedFeature = { clickedLocation: action.payload.event.lngLat, feature }
      } else {
        state.value.selectedFeature = undefined
      }
    },
    onMapMouseMove: (
      state,
      action: PayloadAction<{ features: mapboxgl.MapboxGeoJSONFeature[] | undefined; lngLat: mapboxgl.LngLat }>
    ) => {
      const feature = action.payload.features?.[0]
      if (feature && state.value.allInteractiveLayerIds.includes(feature.layer.id as MAP_LAYERS)) {
        state.value.hoveredFeature = { clickedLocation: action.payload.lngLat, feature }
      }
    },
    onMapMouseEnter: (
      state,
      action: PayloadAction<{ features: mapboxgl.MapboxGeoJSONFeature[] | undefined; lngLat: mapboxgl.LngLat }>
    ) => {
      state.value.cursor = 'pointer'
      const feature = action.payload.features?.[0]
      if (feature && state.value.allInteractiveLayerIds.includes(feature.layer.id as MAP_LAYERS)) {
        state.value.hoveredFeature = { clickedLocation: action.payload.lngLat, feature }
      } else {
        state.value.hoveredFeature = undefined
      }
    },
    onMapMouseLeave: (state) => {
      state.value.cursor = ''
      state.value.hoveredFeature = undefined
    },
    cleanUpLiveStreaming: (state) => {
      if (state.value.wsClient) {
        state.value.wsClient.disconnect(() => {
          console.debug('Disconnected from STOMP endpoint')
        })
        state.value.timeWindowSeconds = 60
      }
      state.value.wsClient = undefined
    },
    setLoadInitialdataTimeoutId: (state, action: PayloadAction<NodeJS.Timeout>) => {
      state.value.loadInitialDataTimeoutId = action.payload
    },
    clearSelectedFeature: (state) => {
      state.value.selectedFeature = undefined
    },
    clearHoveredFeature: (state) => {
      state.value.hoveredFeature = undefined
    },
    setLaneLabelsVisible: (state, action: PayloadAction<boolean>) => {
      state.value.laneLabelsVisible = action.payload
    },
    setSigGroupLabelsVisible: (state, action: PayloadAction<boolean>) => {
      state.value.sigGroupLabelsVisible = action.payload
    },
    setShowPopupOnHover: (state, action: PayloadAction<boolean>) => {
      state.value.showPopupOnHover = action.payload
    },
    toggleLiveDataActive: (state) => {
      state.value.liveDataActive = !state.value.liveDataActive
    },
    setBsmTrailLength: (state, action: PayloadAction<number>) => {
      state.value.bsmTrailLength = action.payload
    },
    setTimeWindowSeconds: (state, action: PayloadAction<number>) => {
      state.value.bsmTrailLength = action.payload
    },
    setRawData: (state, action: PayloadAction<RAW_MESSAGE_DATA_EXPORT>) => {
      state.value.rawData.map = action.payload.map ?? state.value.rawData.map
      state.value.rawData.spat = action.payload.spat ?? state.value.rawData.spat
      state.value.rawData.bsm = action.payload.bsm ?? state.value.rawData.bsm
      state.value.rawData.notification = action.payload.notification ?? state.value.rawData.notification
      state.value.rawData.event = action.payload.event ?? state.value.rawData.event
      state.value.rawData.assessment = action.payload.assessment ?? state.value.rawData.assessment
    },
    setMapProps: (state, action: PayloadAction<MAP_PROPS>) => {
      state.value.sourceData = action.payload.sourceData
      state.value.sourceDataType = action.payload.sourceDataType
      state.value.loadOnNull = action.payload.loadOnNull ?? true
    },
    setSourceApi: (state, action: PayloadAction<MAP_PROPS['sourceApi']>) => {
      state.value.sourceApi = action.payload
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(getSurroundingEvents.fulfilled, (state, action: PayloadAction<MessageMonitor.Event[]>) => {
        state.value.surroundingEvents = action.payload
      })
      .addCase(getSurroundingNotifications.fulfilled, (state, action: PayloadAction<MessageMonitor.Notification[]>) => {
        state.value.surroundingNotifications = action.payload
      })
      .addCase(
        pullInitialData.fulfilled,
        (
          state,
          action: PayloadAction<
            | {
                mapData: ProcessedMap
                connectingLanes: ConnectingLanesFeatureCollection
                spatSignalGroups: SpatSignalGroups
                mapSignalGroups: SignalStateFeatureCollection
                mapTime: number
              }
            | undefined
          >
        ) => {
          if (!action.payload) return
          state.value.mapData = action.payload.mapData
          if (action.payload.mapData != null)
            state.value.viewState = {
              latitude: action.payload.mapData.properties.refPoint.latitude,
              longitude: action.payload.mapData.properties.refPoint.longitude,
              zoom: 19,
            }
          state.value.connectingLanes = action.payload.connectingLanes
          state.value.spatSignalGroups = action.payload.spatSignalGroups
          state.value.mapSignalGroups = action.payload.mapSignalGroups
          state.value.mapSpatTimes = { ...state.value.mapSpatTimes, mapTime: action.payload.mapTime }
        }
      )
      .addCase(
        renderEntireMap.fulfilled,
        (
          state,
          action: PayloadAction<{
            mapData: ProcessedMap
            connectingLanes: ConnectingLanesFeatureCollection
            spatSignalGroups: SpatSignalGroups
            mapSignalGroups: SignalStateFeatureCollection
            mapTime: number
            bsmData: BsmFeatureCollection
            rawData: any
            sliderValue: number
          }>
        ) => {
          state.value.mapData = action.payload.mapData
          if (action.payload.mapData != null)
            state.value.viewState = {
              latitude: action.payload.mapData.properties.refPoint.latitude,
              longitude: action.payload.mapData.properties.refPoint.longitude,
              zoom: 19,
            }
          state.value.connectingLanes = action.payload.connectingLanes
          state.value.spatSignalGroups = action.payload.spatSignalGroups
          state.value.mapSignalGroups = action.payload.mapSignalGroups
          state.value.mapSpatTimes = { ...state.value.mapSpatTimes, mapTime: action.payload.mapTime }
          state.value.bsmData = action.payload.bsmData
          state.value.rawData = action.payload.rawData
          state.value.sliderValue = action.payload.sliderValue
          state.value.sliderTimeValue = getNewSliderTimeValue(
            state.value.queryParams.startDate,
            state.value.sliderValue,
            state.value.timeWindowSeconds
          )
        }
      )
      .addCase(
        renderIterative_Map.fulfilled,
        (
          state,
          action: PayloadAction<{
            currentMapData: ProcessedMap[]
            connectingLanes: ConnectingLanesFeatureCollection
            mapData: ProcessedMap
            mapTime: number
            mapSignalGroups: SignalStateFeatureCollection
          }>
        ) => {
          state.value.currentMapData = action.payload.currentMapData
          const previousMapMessage: ProcessedMap | undefined = action.payload.currentMapData.at(-1)
          if (
            state.value.mapData != null &&
            (state.value.mapData.properties.refPoint.latitude != previousMapMessage?.properties.refPoint.latitude ||
              state.value.mapData.properties.refPoint.longitude != previousMapMessage?.properties.refPoint.longitude)
          )
            state.value.viewState = {
              latitude: action.payload.mapData.properties.refPoint.latitude,
              longitude: action.payload.mapData.properties.refPoint.longitude,
              zoom: 19,
            }
          state.value.connectingLanes = action.payload.connectingLanes
          state.value.mapData = action.payload.mapData
          state.value.mapSignalGroups = action.payload.mapSignalGroups
          state.value.mapSpatTimes = { ...state.value.mapSpatTimes, mapTime: action.payload.mapTime }
        }
      )
      .addCase(
        renderIterative_Spat.fulfilled,
        (
          state,
          action: PayloadAction<{
            currentProcessedSpatDataLocal: ProcessedSpat[]
            currentSpatSignalGroupsLocal: SpatSignalGroups
          }>
        ) => {
          state.value.currentSpatData = action.payload.currentProcessedSpatDataLocal
          state.value.spatSignalGroups = action.payload.currentSpatSignalGroupsLocal
        }
      )
      .addCase(renderIterative_Bsm.fulfilled, (state, action: PayloadAction<BsmFeatureCollection>) => {
        state.value.currentBsmData = action.payload
      })
      .addCase(
        updateRenderedMapState.fulfilled,
        (
          state,
          action: PayloadAction<{
            currentSignalGroups: SpatSignalGroup[] | undefined
            signalStateData: SignalStateFeatureCollection | undefined
            spatTime: number | undefined
            currentBsms: BsmFeatureCollection
            filteredSurroundingEvents: MessageMonitor.Event[]
            filteredSurroundingNotifications: MessageMonitor.Notification[]
          }>
        ) => {
          state.value.currentSignalGroups = action.payload.currentSignalGroups ?? state.value.currentSignalGroups
          state.value.signalStateData = action.payload.signalStateData ?? state.value.signalStateData
          state.value.mapSpatTimes = {
            ...state.value.mapSpatTimes,
            spatTime: action.payload.spatTime ?? state.value.mapSpatTimes.spatTime,
          }
          state.value.currentBsms = action.payload.currentBsms
          state.value.filteredSurroundingEvents = action.payload.filteredSurroundingEvents
          state.value.filteredSurroundingNotifications = action.payload.filteredSurroundingNotifications
        }
      )
  },
})

export const selectLoading = (state: RootState) => state.intersectionMap.loading

export const selectLayersVisible = (state: RootState) => state.intersectionMap.value.layersVisible
export const selectAllInteractiveLayerIds = (state: RootState) => state.intersectionMap.value.allInteractiveLayerIds
export const selectQueryParams = (state: RootState) => state.intersectionMap.value.queryParams
export const selectSourceApi = (state: RootState) => state.intersectionMap.value.sourceApi
export const selectSourceData = (state: RootState) => state.intersectionMap.value.sourceData
export const selectSourceDataType = (state: RootState) => state.intersectionMap.value.sourceDataType
export const selectIntersectionId = (state: RootState) => state.intersectionMap.value.intersectionId
export const selectRoadRegulatorId = (state: RootState) => state.intersectionMap.value.roadRegulatorId
export const selectLoadOnNull = (state: RootState) => state.intersectionMap.value.loadOnNull
export const selectMapData = (state: RootState) => state.intersectionMap.value.mapData
export const selectBsmData = (state: RootState) => state.intersectionMap.value.bsmData
export const selectMapSignalGroups = (state: RootState) => state.intersectionMap.value.mapSignalGroups
export const selectSignalStateData = (state: RootState) => state.intersectionMap.value.signalStateData
export const selectSpatSignalGroups = (state: RootState) => state.intersectionMap.value.spatSignalGroups
export const selectCurrentSignalGroups = (state: RootState) => state.intersectionMap.value.currentSignalGroups
export const selectCurrentBsms = (state: RootState) => state.intersectionMap.value.currentBsms
export const selectConnectingLanes = (state: RootState) => state.intersectionMap.value.connectingLanes
export const selectSurroundingEvents = (state: RootState) => state.intersectionMap.value.surroundingEvents
export const selectFilteredSurroundingEvents = (state: RootState) =>
  state.intersectionMap.value.filteredSurroundingEvents
export const selectSurroundingNotifications = (state: RootState) => state.intersectionMap.value.surroundingNotifications
export const selectFilteredSurroundingNotifications = (state: RootState) =>
  state.intersectionMap.value.filteredSurroundingNotifications
export const selectViewState = (state: RootState) => state.intersectionMap.value.viewState
export const selectTimeWindowSeconds = (state: RootState) => state.intersectionMap.value.timeWindowSeconds
export const selectSliderValue = (state: RootState) => state.intersectionMap.value.sliderValue
export const selectRenderTimeInterval = (state: RootState) => state.intersectionMap.value.renderTimeInterval
export const selectHoveredFeature = (state: RootState) => state.intersectionMap.value.hoveredFeature
export const selectSelectedFeature = (state: RootState) => state.intersectionMap.value.selectedFeature
export const selectRawData = (state: RootState) => state.intersectionMap.value.rawData
export const selectMapSpatTimes = (state: RootState) => state.intersectionMap.value.mapSpatTimes
export const selectSigGroupLabelsVisible = (state: RootState) => state.intersectionMap.value.sigGroupLabelsVisible
export const selectLaneLabelsVisible = (state: RootState) => state.intersectionMap.value.laneLabelsVisible
export const selectShowPopupOnHover = (state: RootState) => state.intersectionMap.value.showPopupOnHover
export const selectImportedMessageData = (state: RootState) => state.intersectionMap.value.importedMessageData
export const selectCursor = (state: RootState) => state.intersectionMap.value.cursor
export const selectLoadInitialDataTimeoutId = (state: RootState) => state.intersectionMap.value.loadInitialDataTimeoutId
// export const selectWsClient = (state: RootState) => state.intersectionMap.value.wsClient;
export const selectLiveDataActive = (state: RootState) => state.intersectionMap.value.liveDataActive
export const selectCurrentMapData = (state: RootState) => state.intersectionMap.value.currentMapData
export const selectCurrentSpatData = (state: RootState) => state.intersectionMap.value.currentSpatData
export const selectCurrentBsmData = (state: RootState) => state.intersectionMap.value.currentBsmData
export const selectSliderTimeValue = (state: RootState) => state.intersectionMap.value.sliderTimeValue
export const selectBsmTrailLength = (state: RootState) => state.intersectionMap.value.bsmTrailLength

export const {
  setSurroundingEvents,
  maybeUpdateSliderValue,
  setViewState,
  handleImportedMapMessageData,
  updateQueryParams,
  onTimeQueryChanged,
  setSliderValue,
  updateRenderTimeInterval,
  onMapClick,
  onMapMouseMove,
  onMapMouseEnter,
  onMapMouseLeave,
  cleanUpLiveStreaming,
  setLoadInitialdataTimeoutId,
  clearSelectedFeature,
  clearHoveredFeature,
  setLaneLabelsVisible,
  setSigGroupLabelsVisible,
  setShowPopupOnHover,
  toggleLiveDataActive,
  setBsmTrailLength,
  setRawData,
  setMapProps,
  setSourceApi,
} = intersectionMapSlice.actions

export default intersectionMapSlice.reducer
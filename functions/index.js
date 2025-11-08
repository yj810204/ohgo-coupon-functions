const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const axios = require('axios'); // 푸시 알림을 위한 axios 라이브러리 추가
admin.initializeApp();

// --- 설정 상수: 이곳에서 주요 값을 쉽게 변경할 수 있습니다. ---
const REGION = 'asia-northeast3';
const BAIT_USAGE_LIMIT = 20;

/**
 * Firestore Timestamp를 한국 시간 기준의 'YYYY-MM-DD' 문자열로 변환합니다.
 * @param {admin.firestore.Timestamp} timestamp - 변환할 타임스탬프.
 * @returns {string} KST 날짜 문자열.
 */
const getKoreanDateString = (timestamp) => {
    const date = timestamp.toDate();
    const krTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    return krTime.toISOString().split('T')[0];
};

/**
 * 포인트 지급 거부 시 처리할 작업을 수행합니다.
 * (포인트 문서 삭제, totalPoint 차감, 관리자 푸시 알림, 사용자 푸시 알림)
 * @param {object} params - 필요한 파라미터.
 * @param {FirebaseFirestore.DocumentReference} params.pointDocRef - 삭제할 포인트 문서의 참조.
 * @param {string} params.userId - 해당 사용자 ID.
 * @param {number} params.baitUsed - 사용된 미끼 개수.
 * @param {FirebaseFirestore.DocumentData} params.pointData - 삭제될 포인트 문서의 데이터.
 * @param {FirebaseFirestore.DocumentSnapshot} params.userDoc - 사용자 문서 스냅샷.
 */
const handleRejection = async ({ pointDocRef, userId, baitUsed, pointData, userDoc }) => {
    const db = admin.firestore();
    const fraudulentPoints = pointData.point || 0;
    const userRef = db.collection('users').doc(userId);

    // 사용자 정보는 전달받은 userDoc에서 사용합니다.
    const userData = userDoc.data();
    const expoPushToken = userData?.expoPushToken;
    const userName = userData?.name || '알 수 없는 사용자';

    const promises = [];

    // 작업 1: 포인트 문서 삭제
    promises.push(pointDocRef.delete());

    // 작업 2: totalPoint에서 획득했던 포인트 차감
    if (fraudulentPoints > 0) {
        promises.push(userRef.update({
            totalPoint: admin.firestore.FieldValue.increment(-fraudulentPoints)
        }));
    }

    // 작업 3: 사용자에게 푸시 알림 전송
    if (expoPushToken) {
        const message = {
            to: expoPushToken,
            sound: 'default',
            title: '포인트 지급이 취소되었어요',
            body: `일일 미끼 사용량 초과로 인해 포인트 획득이 자동으로 취소 처리되었어요.`,
        };
        promises.push(
            axios.post('https://exp.host/--/api/v2/push/send', message)
                .then(() => console.log(`사용자 '${userName}(${userId})'에게 푸시 알림을 성공적으로 보냈습니다.`))
                .catch(err => console.error(`사용자 '${userName}(${userId})'에게 푸시 알림 전송을 실패했습니다:`, err.response?.data || err.message))
        );
    }

    // 작업 4: 모든 관리자에게 푸시 알림 전송
    const adminsQuery = db.collection('users').where('isAdmin', '==', true);
    const adminPushPromise = adminsQuery.get().then(adminSnapshot => {
        const adminTokens = [];
        adminSnapshot.forEach(doc => {
            const token = doc.data().expoPushToken;
            if (token) {
                adminTokens.push(token);
            }
        });

        if (adminTokens.length > 0) {
            const adminMessage = {
                to: adminTokens,
                sound: 'default',
                title: '부정 포인트 획득이 감지되었어요',
                body: `${userName}/${userId}(이)가 일일 미끼 사용량(${baitUsed}개)을 초과하여 포인트 획득이 차단되었어요.`,
            };
            return axios.post('https://exp.host/--/api/v2/push/send', adminMessage)
                .then(() => console.log('관리자들에게 푸시 알림을 성공적으로 보냈습니다.'))
                .catch(err => console.error('관리자들에게 푸시 알림 전송을 실패했습니다:', err.response?.data || err.message));
        }
    });
    promises.push(adminPushPromise);


    await Promise.all(promises);
    console.log(`사용자 '${userName}(${userId})'의 포인트가 거부 처리되었습니다.`);
};

// --- 메인 Cloud Function ---
exports.validatePointsOnCreate = functions
    .region(REGION)
    .firestore.document('users/{userId}/points/{pointId}')
    .onCreate(async (snap, context) => {
        try {
            const { userId } = context.params;
            const pointData = snap.data();
            const db = admin.firestore();

            // 사용자 정보를 로깅 및 후속 처리를 위해 미리 가져옵니다.
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            // 사용자가 존재하지 않는 예외적인 경우를 처리합니다.
            if (!userDoc.exists) {
                console.error(`사용자 문서가 존재하지 않습니다: ${userId}`);
                return null;
            }
            const userName = userDoc.data()?.name || '알 수 없는 사용자';


            if (!pointData.at || typeof pointData.at.toDate !== 'function') {
                console.warn(`사용자 '${userName}(${userId})'의 points 문서에 'at' 필드가 없어 검증을 건너뜁니다.`);
                return null;
            }

            const dateString = getKoreanDateString(pointData.at);
            const baitUsageRef = db.collection('users').doc(userId).collection('baitUsage').doc(dateString);
            const baitUsageDoc = await baitUsageRef.get();
            const baitUsed = baitUsageDoc.data()?.used || 0;

            if (baitUsageDoc.exists && baitUsed > BAIT_USAGE_LIMIT) {
                console.log(`사용자 '${userName}(${userId})'가 미끼 ${baitUsed}개를 사용하여 포인트 획득이 거부됩니다.`);
                // 조회한 userDoc을 handleRejection 함수로 전달하여 중복 조회를 방지합니다.
                await handleRejection({ pointDocRef: snap.ref, userId, baitUsed, pointData, userDoc });
            } else {
                console.log(`사용자 '${userName}(${userId})'의 포인트가 정상적으로 추가되었습니다. (미끼 사용량: ${baitUsed}개)`);
            }
            return null;
        } catch (error) {
            console.error('validatePointsOnCreate 함수 실행 중 심각한 오류 발생:', error);
            return null;
        }
    });

// --- [수정됨] 미끼 쿠폰 음수 값 방지 및 사용량 복원 함수 ---
exports.enforceBaitCouponPolicy = functions
    .region(REGION)
    .firestore.document('users/{userId}')
    .onUpdate(async (change) => {
        const newData = change.after.data();
        const oldData = change.before.data();
        const userId = change.after.id;
        const db = admin.firestore();

        // baitCoupons 필드가 업데이트되었고, 그 값이 0보다 작아졌는지 확인합니다.
        if (newData.baitCoupons < 0 && newData.baitCoupons !== oldData.baitCoupons) {
            const userName = newData.name || '알 수 없는 사용자';

            console.log(`사용자 '${userName}(${userId})'의 미끼쿠폰이 ${newData.baitCoupons}(으)로 비정상 감지되어 0으로 조정하고, 오늘의 미끼 사용량을 10으로 강제 설정합니다.`);

            try {
                const today = getKoreanDateString(admin.firestore.Timestamp.now());
                const baitUsageRef = db.collection('users').doc(userId).collection('baitUsage').doc(today);

                const promises = [];

                // 작업 1: baitCoupons 값을 0으로 강제 업데이트합니다.
                promises.push(change.after.ref.update({ baitCoupons: 0 }));

                // 작업 2: 오늘의 baitUsage.used 값을 10으로 강제 설정하고, date 필드도 함께 기록합니다.
                promises.push(baitUsageRef.set(
                    {
                        used: 10, // increment가 아닌 10으로 값을 고정합니다.
                        date: today // date 필드를 추가하여 문서 구조의 일관성을 유지합니다.
                    },
                    { merge: true }
                ));

                // 작업 3: 관리자들에게 이 비정상적인 상황과 조치 내용을 알립니다.
                const adminsQuery = db.collection('users').where('isAdmin', '==', true);
                const adminNotificationPromise = adminsQuery.get().then(async (adminSnapshot) => {
                    const adminTokens = [];
                    adminSnapshot.forEach(doc => {
                        const token = doc.data().expoPushToken;
                        if (token) adminTokens.push(token);
                    });

                    if (adminTokens.length > 0) {
                        const adminMessage = {
                            to: adminTokens,
                            sound: 'default',
                            title: '비정상 쿠폰 사용 감지 및 조치 완료',
                            body: `${userName}/${userId}의 쿠폰이 음수(${newData.baitCoupons})가 되어 0으로 수정되었으며, 오늘의 미끼 사용량을 10으로 강제 설정했습니다.`,
                        };
                        await axios.post('https://exp.host/--/api/v2/push/send', adminMessage);
                    }
                });
                promises.push(adminNotificationPromise);

                await Promise.all(promises);
                return null;

            } catch (error) {
                console.error(`사용자 '${userName}(${userId})'의 baitCoupons 수정 및 사용량 복원에 실패했습니다:`, error);
                return null;
            }
        }
        return null; // baitCoupons에 문제가 없으면 아무 작업도 하지 않습니다.
    });


// 스탬프 생성 시 쿠폰/승선명부를 "확인 후 처리"하는 함수 ---
exports.processQrScanOnStampCreation_transitional = functions
    .region(REGION)
    .firestore.document('users/{userId}/stamps/{stampId}')
    .onCreate(async (snap, context) => {
        const { userId, stampId } = context.params;
        const db = admin.firestore();
        const now = admin.firestore.Timestamp.now();
        const today = getKoreanDateString(now);

        const stampData = snap.data();
        if (stampData.processedByServer) {
            console.log(`QR Log: Stamp ${stampId} for user ${userId} has already been processed.`);
            return null;
        }

        // 스탬프가 생성된 method 확인
        const method = stampData.method || "UNKNOWN";
        console.log(`QR Log: Stamp ${stampId} for user ${userId} created via method: ${method}`);

        try {
            let userName; // 푸시 알림에서도 사용할 수 있도록 외부에 선언
            let captainPreRegistered = false;
            let baitRevoked = false;
            let couponFlagCleared = false;

            await db.runTransaction(async (transaction) => {
                const userRef = db.collection('users').doc(userId);
                const attendanceRef = db.collection('attendance').doc(today);
                const stampRef = snap.ref;

                // 트랜잭션 내에서 최신 데이터를 다시 읽어옵니다.
                const [userDoc, stampDoc, attendanceDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(stampRef),
                    transaction.get(attendanceRef),
                ]);

                // 중복 처리 방지 체크
                if (stampDoc.data().processedByServer) {
                    return;
                }

                // 사용자 문서 존재 여부 확인
                if (!userDoc.exists) {
                    console.error(`QR Log: 사용자 문서가 존재하지 않습니다: ${userId}`);
                    // 처리 완료 플래그만 설정하고 종료 (중복 실행 방지)
                    transaction.update(stampRef, { processedByServer: true });
                    return;
                }

                userName = userDoc.data().name || '알 수 없는 사용자';

                // 스탬프 ID 기반 쿠폰 필드 이름 정의
                const couponFieldName = `couponAwardedFor_${stampId}`;

                // method가 QR인 경우에만 승선 명부와 미끼 교환권을 처리
                if (method === "QR") {
                    const attendanceData = attendanceDoc.exists ? attendanceDoc.data() : {};
                    const existingMembers = Array.isArray(attendanceData?.members) ? attendanceData.members : [];
                    const alreadyInAttendance = existingMembers.includes(userId);
                    captainPreRegistered = alreadyInAttendance;

                    // 1. 승선 명부 확인 및 처리 (문서 존재 여부에 따라 다르게 처리)
                    if (attendanceDoc.exists) {
                        // 문서가 존재하면 update로 arrayUnion 사용
                        const attendanceUpdatePayload = {
                            updatedAt: now,
                        };

                        if (!alreadyInAttendance) {
                            attendanceUpdatePayload.members = admin.firestore.FieldValue.arrayUnion(userId);
                        }

                        transaction.update(attendanceRef, attendanceUpdatePayload);
                    } else {
                        // 문서가 없으면 set으로 새 배열 생성
                        transaction.set(attendanceRef, {
                            members: [userId],
                            date: now,
                            updatedAt: now,
                        });
                    }

                    // 2. 미끼 교환권 확인 및 처리 (중복 지급 방지)
                    if (alreadyInAttendance) {
                        const userUpdates = {};
                        const currentBaitCoupons = Number(userDoc.data()?.baitCoupons) || 0;

                        if (currentBaitCoupons > 0) {
                            userUpdates.baitCoupons = admin.firestore.FieldValue.increment(-1);
                            baitRevoked = true;
                        }

                        if (userDoc.data()?.[couponFieldName]) {
                            userUpdates[couponFieldName] = admin.firestore.FieldValue.delete();
                            couponFlagCleared = true;
                        }

                        if (Object.keys(userUpdates).length > 0) {
                            transaction.update(userRef, userUpdates);
                        }

                        transaction.delete(stampRef);

                        console.log(`QR Log (Transitional): '${userName}(${userId})'님은 이미 선장에 의해 승선 명부에 등록되어 QR 스캔에 따른 추가 미끼/스탬프 지급 없이 처리되었습니다.`);
                    } else {
                        transaction.update(userRef, {
                            baitCoupons: admin.firestore.FieldValue.increment(1),
                            [couponFieldName]: true,
                            tripCount: admin.firestore.FieldValue.increment(1)
                        });

                        // 3. 승선 횟수 증가 (crew 여부와 관계없이 모든 승선자 카운트)
                        console.log(`QR Log (Transitional): '${userName}(${userId})'님의 QR 스탬프 처리를 확인하고 완료했습니다.`);
                    }
                } else if (method === "ADMIN") {
                    // ADMIN 방식일 경우 승선 명부와 미끼 교환권을 지급하지 않음
                    // 하지만 승선 횟수는 증가시킴 (관리자 직접 등록도 승선으로 간주)
                    transaction.update(userRef, {
                        tripCount: admin.firestore.FieldValue.increment(1)
                    });
                    console.log(`QR Log (Transitional): '${userName}(${userId})'님의 ADMIN 스탬프가 처리되었습니다.`);
                }

                // 3. 서버 처리 완료 플래그 설정 (이 함수 중복 실행 방지) - 모든 방식에서 공통
                if (!(method === "QR" && captainPreRegistered)) {
                    transaction.update(stampRef, { processedByServer: true });
                }
            });

            // --- 푸시 알림 전송 로직 ---
            const userDocAfter = await db.collection('users').doc(userId).get();
            const userDataAfter = userDocAfter.data();
            const userPushToken = userDataAfter?.expoPushToken;
            userName = userDataAfter?.name || '알 수 없는 사용자'; // 최신 이름 정보로 업데이트

            const notificationPromises = [];

            // 사용자에게 알림 전송
            if (userPushToken) {
                let userMessageTitle = '스탬프 적립 완료!';
                let userMessageBody;

                if (method === "QR") {
                    if (captainPreRegistered) {
                        userMessageTitle = 'QR 스캔 확인';
                        userMessageBody = `${userName}님, 이미 선장이 승선 명부에 등록한 상태여서 QR 스캔은 확인만 되었고 추가 스탬프·미끼는 지급되지 않았어요.`;
                    } else {
                        userMessageBody = `${userName}님, 미끼 교환권 1장이 지급되었으며 승선 명부에 등록되었습니다.`;
                    }
                } else if (method === "ADMIN") {
                    userMessageBody = `${userName}님, 관리자에 의해 스탬프가 적립되었습니다.`;
                } else {
                    userMessageBody = `${userName}님, 스탬프가 적립되었습니다.`;
                }

                const userMessage = {
                    to: userPushToken,
                    sound: 'default',
                    title: userMessageTitle,
                    body: userMessageBody
                };
                notificationPromises.push(
                    axios.post('https://exp.host/--/api/v2/push/send', userMessage)
                        .catch(e => console.error(`사용자 '${userName}(${userId})' 푸시알림 실패:`, e.message))
                );
            }

            // 관리자에게 알림 전송 (method에 따라 메시지 내용 변경)
            if (method === "QR" || method === "ADMIN") {
                const adminsQuery = db.collection('users').where('isAdmin', '==', true);
                const adminPushPromise = adminsQuery.get().then(adminSnapshot => {
                    const adminTokens = [];
                    adminSnapshot.forEach(doc => {
                        const token = doc.data().expoPushToken;
                        if (token) adminTokens.push(token);
                    });
                    if (adminTokens.length > 0) {
                        let adminTitle, adminBody;

                        if (method === "QR") {
                            if (captainPreRegistered) {
                                adminTitle = 'QR 중복 처리 알림';
                                adminBody = `사용자 '${userName}(${userId})'님은 선장이 이미 명부에 올린 상태여서 QR 스캔 시 추가 스탬프/미끼 없이 확인 처리되었습니다.`;
                            } else {
                                adminTitle = '승선 알림';
                                adminBody = `사용자 '${userName}(${userId})'님이 QR 스캔을 완료하고 승선 명부에 등록되었습니다.`;
                            }
                        } else if (method === "ADMIN") {
                            adminTitle = '스탬프 적립 알림';
                            adminBody = `사용자 '${userName}(${userId})'님에게 관리자 권한으로 스탬프가 적립되었습니다.`;
                        }

                        const adminMessage = {
                            to: adminTokens,
                            sound: 'default',
                            title: adminTitle,
                            body: adminBody
                        };
                        return axios.post('https://exp.host/--/api/v2/push/send', adminMessage)
                            .catch(e => console.error(`관리자 푸시알림 실패:`, e.message));
                    }
                });
                notificationPromises.push(adminPushPromise);
            }

            await Promise.all(notificationPromises);
            console.log(`QR Log: '${userName}(${userId})'님 관련 푸시 알림 전송 완료.`);

            // 최종 로그 기록 (트랜잭션 성공 후)
            let actionDetail, actionType;

            if (method === "QR") {
                if (captainPreRegistered) {
                    actionType = 'qrScanPreRegisteredResolved';
                    actionDetail = `Captain pre-registered passenger; bait${baitRevoked ? ' revoked' : ' unchanged'} and stamp entry was rolled back${couponFlagCleared ? ', coupon flag cleared' : ''}.`;
                } else {
                    actionType = 'qrScanProcessed_transitional';
                    actionDetail = 'Server ensured bait coupon and attendance list are correct during transition.';
                }
            } else if (method === "ADMIN") {
                actionType = 'adminStampProcessed';
                actionDetail = 'Admin created stamp without affecting attendance or bait coupons.';
            } else {
                actionType = 'unknownMethodStampProcessed';
                actionDetail = `Stamp created with unknown method: ${method}`;
            }

            await db.collection('qrScanActivityLogs').add({
                action: actionType,
                userId: userId,
                userName: userName,
                method: method,
                timestamp: now,
                date: today,
                details: actionDetail,
            });

        } catch (error) {
            console.error(`QR 스캔 과도기 처리 중 오류 발생 (User: ${userId}, Stamp: ${stampId}, Method: ${method}):`, error);
        }
    });